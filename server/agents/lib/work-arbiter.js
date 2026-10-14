import { resolveIntentConflict, intentForGenerator, claimScopeFor, normalizeScopeKey } from './work-claims.js';
import { MAX_DECISION_ENGINE_CALLS_PER_RUN } from './default-bucket-decision.js';

// Settle the competing answers before anything ships.
//
// Phase 1's claims ledger prevents two producers from working the same
// page/keyword/topic at once, but it does it by FIRST COME: whoever reached
// claimWork first keeps it, and the other is skipped. That is the right
// behaviour for a race and the wrong behaviour for a disagreement. Two
// producers proposing a new blog post and an expansion of an existing page
// for one topic are not racing — they are two answers to one question, and
// the better answer should win regardless of which cron fired first.
//
// So this runs AFTER recommendations are produced and BEFORE
// autoRemediateSafeRecommendations. That position is the only correct one:
// arbitration has to see the whole set of proposals, and it has to happen
// before any of them is drafted, or the losing proposal has already cost a
// generation.
//
// Three tiers, in order, and the cheap ones settle nearly everything:
//
//   1. Nothing competing. One proposal per scope key is the common case and
//      costs nothing.
//   2. Deterministic precedence — resolveIntentConflict, the same function
//      the claim path uses, so the arbiter and the ledger cannot disagree
//      about who should own a key.
//   3. decide(), for the residue precedence calls indecisive, and ONLY
//      within the existing max-5-per-run budget. Beyond it, deterministic
//      precedence stands. A new cost control here would be a second,
//      driftable answer to a question default-bucket-decision.js already
//      answered.

export function isWorkArbiterEnabled(env = process.env) {
  return env.WORK_ARBITER_ENABLED === 'true';
}

// Content intents are the only ones that genuinely compete for one outcome.
// A meta-title fix and an expand-content addition on the same page are not
// alternatives to each other — they are both wanted — so grouping them as
// rivals would block real work.
const COMPETING_INTENTS = new Set(['new-blog', 'expand-existing', 'internal-link']);

// What scope key a recommendation is really about, using the ledger's own
// derivation so a key means the same thing in both places.
export function scopeKeyForRecommendation(rec) {
  const generatorId = rec.recommendation_type;
  // claimScopeFor does the derivation, including the special-casing of the
  // generators whose identity is a topic rather than a page. Calling it
  // rather than repeating its rules is what keeps the arbiter's keyspace and
  // the ledger's keyspace identical — two derivations would eventually
  // disagree, and then the arbiter would be adjudicating contests the
  // ledger does not believe in.
  const { scope, scopeKey } = claimScopeFor({ generatorId, params: rec.params || {}, page: rec.page });
  const key = normalizeScopeKey(scope, scopeKey);
  return key ? { scope, scopeKey: key, intent: intentForGenerator(generatorId) } : null;
}

/**
 * Group open recommendations into contests. Pure, so the grouping rule is
 * testable without a database.
 *
 * Returns [{ scope, scopeKey, contenders: [{ rec, intent }] }], only for
 * keys where more than one DISTINCT competing intent is proposed. A key with
 * three new-blog proposals is a dedup problem, not an arbitration problem,
 * and the recommendations index already handles it.
 */
export function findContests(recommendations = []) {
  const byKey = new Map();
  for (const rec of recommendations) {
    const resolved = scopeKeyForRecommendation(rec);
    if (!resolved || !COMPETING_INTENTS.has(resolved.intent)) continue;
    const id = `${resolved.scope}:${resolved.scopeKey}`;
    if (!byKey.has(id)) byKey.set(id, { scope: resolved.scope, scopeKey: resolved.scopeKey, contenders: [] });
    byKey.get(id).contenders.push({ rec, intent: resolved.intent });
  }
  return [...byKey.values()].filter((c) => new Set(c.contenders.map((x) => x.intent)).size > 1);
}

// Fold the contenders down with the same pairwise precedence the claim path
// uses. Pure. Returns { winner, losers, reason, decisive } — `decisive` is
// false when precedence declared a winner only by incumbency, which is the
// residue worth escalating.
// Coverage states from which "is this topic already covered" has a real
// answer. Anything else — null, 'uncertain' — means nobody established it.
const COVERAGE_KNOWN = new Set(['covered', 'duplicate', 'opportunity', 'market_gap', 'language_gap', 'intent_gap']);

// The pair whose correct ordering actually FLIPS on coverage. internal-link
// vs either of these is ordered the same way in both of
// resolveIntentConflict's rankings, so an unknown coverage status does not
// make that pairing any less certain.
const COVERAGE_SENSITIVE = ['new-blog', 'expand-existing'];

export function resolveContestDeterministically(contest, { coverageStatus = null } = {}) {
  const [first, ...rest] = contest.contenders;
  let winner = first;
  let reason = 'sole-contender';

  for (const challenger of rest) {
    const verdict = resolveIntentConflict({
      existingIntent: winner.intent,
      incomingIntent: challenger.intent,
      coverageStatus,
    });
    reason = verdict.reason;
    if (verdict.winner === 'incoming') winner = challenger;
  }

  // Where precedence is genuinely not decisive.
  //
  // resolveIntentConflict flips its ranking on exactly one input: whether
  // the topic is already covered. With no coverage verdict it takes the
  // not-covered branch, which means "write a new page" wins by DEFAULT
  // whenever nobody established coverage — and writing a page that
  // duplicates an existing one is the most expensive mistake available
  // here. So an unknown verdict on the one coverage-sensitive pairing is
  // the residue, and the only place real reasoning is worth paying for.
  const intents = new Set(contest.contenders.map((c) => c.intent));
  const coverageSensitive = COVERAGE_SENSITIVE.every((i) => intents.has(i));
  const decisive = !(coverageSensitive && !COVERAGE_KNOWN.has(coverageStatus));

  return {
    winner,
    losers: contest.contenders.filter((c) => c !== winner),
    reason,
    decisive,
  };
}

const DEFAULT_DEPS = {
  listOpen: null,
  block: null,
  decideFn: null,
  coverageFor: async () => null,
};

async function resolveDeps(injected = {}) {
  if (injected.listOpen && injected.block) return { ...DEFAULT_DEPS, ...injected };
  const [recs, engine] = await Promise.all([
    import('../../store/recommendations.js'),
    // Lazily, for the reason default-bucket-decision.js documents at length:
    // decision-engine.js reaches llm.js and the openai SDK, whose ESM
    // interop breaks under node:test's module mocking. A static import here
    // would drag that into every test that touches the daily chain.
    import('./decision-engine.js').catch(() => null),
  ]);
  return {
    ...DEFAULT_DEPS,
    listOpen: recs.listOpenRecommendations,
    block: recs.blockRecommendation,
    decideFn: engine ? (siteId, situation, evidence) => engine.decisionEngine.decide(siteId, situation, evidence) : null,
    ...injected,
  };
}

/**
 * Arbitrate one site's open proposals.
 *
 * The loser is BLOCKED, never closed. That distinction matters: an expansion
 * that lost to a new blog post this week is not wrong, it is second — and
 * once the blog post ships and the coverage verdict changes, the expansion
 * may well be the right call. Closing it would throw that away; blocking it
 * keeps it on the board with a reason a human can read.
 */
export async function runWorkArbiter(siteId, { site = null, deps: injected = {}, maxDecisionCalls = MAX_DECISION_ENGINE_CALLS_PER_RUN } = {}) {
  if (!isWorkArbiterEnabled()) return { ran: false, reason: 'disabled', contests: 0, blocked: 0 };

  const d = await resolveDeps(injected);
  const open = await d.listOpen(siteId).catch((err) => {
    console.warn(`[work-arbiter] could not read open recommendations for site ${siteId}: ${err.message}`);
    return null;
  });
  if (!open) return { ran: false, reason: 'unavailable', contests: 0, blocked: 0 };

  const contests = findContests(open);
  if (!contests.length) return { ran: true, contests: 0, blocked: 0, decisions: 0, results: [] };

  let decisionCalls = 0;
  const results = [];
  let blocked = 0;

  for (const contest of contests) {
    const coverageStatus = await d.coverageFor(siteId, contest).catch(() => null);
    let { winner, losers, reason, decisive } = resolveContestDeterministically(contest, { coverageStatus });

    // The escalation, strictly bounded. `decisive === false` means
    // precedence produced a winner only because somebody had to be first —
    // the one case where real reasoning is worth paying for.
    if (!decisive && d.decideFn && decisionCalls < maxDecisionCalls && site?.decision_engine_default_bucket_enabled) {
      decisionCalls++;
      const picked = await escalate(siteId, contest, d.decideFn).catch(() => null);
      if (picked) {
        winner = picked;
        losers = contest.contenders.filter((c) => c !== picked);
        reason = 'decided';
      }
    }

    for (const loser of losers) {
      const ok = await d.block(
        loser.rec.id,
        `Held while "${winner.rec.title || winner.rec.recommendation_type}" (${winner.intent}) runs instead for this ${contest.scope} — ${reason}. Both address "${contest.scopeKey}"; this one is second, not wrong, and becomes available again once that work lands.`,
      ).then(() => true).catch(() => false);
      if (ok) blocked++;
    }

    results.push({
      scope: contest.scope,
      scopeKey: contest.scopeKey,
      winnerId: winner.rec.id,
      winnerIntent: winner.intent,
      losers: losers.map((l) => ({ id: l.rec.id, intent: l.intent })),
      reason,
      coverageStatus,
    });
  }

  return { ran: true, contests: contests.length, blocked, decisions: decisionCalls, results };
}

// Ask decide() which of the real contenders to run. Deliberately NOT asking
// it to invent an action: the candidates already exist, and the only open
// question is which one. A free-form answer would have to be mapped back
// onto a contender anyway, and a mapping that fails silently would turn an
// indecisive contest into a dropped one.
async function escalate(siteId, contest, decideFn) {
  const situation =
    `Two or more producers propose different work for the same ${contest.scope} "${contest.scopeKey}": ` +
    contest.contenders.map((c) => `${c.intent} (${c.rec.recommendation_type}, recommendation ${c.rec.id})`).join('; ') +
    '. Only one should run. Which intent serves this site best right now?';

  const evidence = contest.contenders.map((c) => ({
    source: 'recommendations',
    summary: `${c.rec.recommendation_type}: ${c.rec.title || '(no title)'} — ${c.rec.why_it_matters || 'no stated rationale'}`,
    ref: `recommendations:${c.rec.id}`,
  }));

  const decision = await decideFn(siteId, situation, evidence);
  if (!decision) return null;

  // The engine's action vocabulary maps onto intents; anything else means
  // it did not answer the question it was asked, and precedence stands.
  const wanted = { new_page: 'new-blog', improve_page: 'expand-existing', internal_linking: 'internal-link' }[decision.action];
  if (!wanted) return null;
  return contest.contenders.find((c) => c.intent === wanted) || null;
}
