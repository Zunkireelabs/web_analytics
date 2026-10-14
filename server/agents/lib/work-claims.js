import { query } from '../../db.js';

// One owner per page/keyword/topic at a time, across all nine producers.
// See migration 180 for why the recommendations dedup index cannot answer
// this and why the index here deliberately omits the generator.
//
// Failing soft is the rule everywhere in this file: a claim that cannot be
// taken because the ledger is unreachable must not stop real work. The
// ledger prevents duplicates; it is not a correctness gate, and treating it
// as one would make a transient DB hiccup look like a platform outage.

// How long a producer holds a claim before it is considered abandoned.
// Matches the Action Center reconciler's own 24-hour window for reclaiming
// stalled attempts, so a claim and the attempt it guards expire together
// rather than one outliving the other.
export const DEFAULT_TTL_HOURS = 24;

export const SCOPES = new Set(['page', 'keyword', 'topic']);

// What a producer means to do. Two intents on one topic are not duplicates
// by type — they are competing answers to one question, which is what makes
// deterministic arbitration possible below.
export const INTENTS = new Set([
  'new-blog', 'expand-existing', 'internal-link', 'meta', 'repair', 'technical',
]);

// Case, www, trailing slash and hash must not produce two owners for one
// thing. Mirrors normalizePageForKey in recommendation-coordinator.js so the
// two keyspaces agree; a page claimed here and a recommendation deduped
// there must be talking about the same page.
export function normalizeScopeKey(scope, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (scope === 'page') {
    try {
      const u = new URL(value, 'https://placeholder.invalid');
      u.hostname = u.hostname.replace(/^www\./i, '');
      u.hash = '';
      u.search = '';
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
      // Path only: the same page claimed via its live URL and via a
      // site-relative permalink is one page.
      return u.pathname.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }
  // Keywords and topics: collapse whitespace and punctuation noise so
  // "AI content tools", "ai  content tools" and "ai-content-tools" are one
  // topic rather than three.
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

// Deterministic arbitration between an incumbent claim and a newcomer with a
// different intent for the same thing.
//
// Deliberately NOT an LLM call. The evidence needed is already present —
// migration 179's coverage_status and cannibalization-decision.js — and what
// was missing was a seat to decide in, not intelligence. A deterministic
// table is reviewable, cheap, and cannot drift between runs; the Decision
// Engine is the right home for the genuinely ambiguous residue, not for this.
//
// The ranking inverts with coverage, which is the real insight: when a topic
// is already covered, publishing another page on it is cannibalization, so
// linking or expanding wins. When it is a genuine gap, a new page wins.
const RANK_WHEN_COVERED = ['internal-link', 'expand-existing', 'new-blog'];
const RANK_WHEN_GAP = ['new-blog', 'expand-existing', 'internal-link'];

export function resolveIntentConflict({ existingIntent, incomingIntent, coverageStatus = null }) {
  if (existingIntent === incomingIntent) {
    return { winner: 'existing', reason: 'same-intent' };
  }
  const covered = coverageStatus === 'covered' || coverageStatus === 'duplicate';
  const ranking = covered ? RANK_WHEN_COVERED : RANK_WHEN_GAP;
  const existingRank = ranking.indexOf(existingIntent);
  const incomingRank = ranking.indexOf(incomingIntent);

  // An intent outside the ranking (meta, repair, technical) is not competing
  // for the same outcome as a content intent, so the incumbent simply keeps
  // the claim. Stability over churn: re-deciding ownership on every run
  // would let two producers trade a page back and forth all day.
  if (existingRank === -1 || incomingRank === -1) {
    return { winner: 'existing', reason: 'incumbent-holds' };
  }
  if (incomingRank < existingRank) {
    return {
      winner: 'incoming',
      reason: covered ? 'covered-prefers-' + incomingIntent : 'gap-prefers-' + incomingIntent,
    };
  }
  return { winner: 'existing', reason: 'incumbent-outranks' };
}

// Enforcement is opt-in, like every other gate in this phase. Unset, nothing
// calls claimWork at all, so the ledger stays empty and behaviour is
// unchanged.
export function isClaimsEnforcing(env = process.env) {
  return env.WORK_CLAIMS_ENABLED === 'true';
}

// What a generator is actually trying to achieve. This is the translation
// that makes arbitration possible: the recommendations table knows
// `recommendation_type` (which generator), and that cannot answer "are these
// two producers trying to do the same thing by different means".
const INTENT_BY_GENERATOR = {
  'blog-outline': 'new-blog',
  'landing-page': 'new-blog',
  'comparison-page': 'new-blog',
  'translation': 'new-blog',
  'expand-content': 'expand-existing',
  'faq': 'expand-existing',
  'qa-content': 'expand-existing',
  'direct-answer': 'expand-existing',
  'internal-links': 'internal-link',
  'meta-title': 'meta',
  'meta-description': 'meta',
  'canonical': 'meta',
  'schema': 'meta',
  'content-integrity-repair': 'repair',
  'broken-link-fix': 'repair',
  'missing-page-create': 'repair',
};

export function intentForGenerator(generatorId) {
  return INTENT_BY_GENERATOR[generatorId] || 'technical';
}

// Which thing a recommendation actually competes for.
//
// A page fix contends on its page; a content generator contends on its TOPIC,
// because two producers proposing a blog post and a landing page for the same
// topic are duplicating work even though they touch different (not yet
// existing) files. This mirrors recommendationPageKey's own special-casing of
// the generators whose identity is a topic rather than a page — see its
// comment on blog-outline and landing-page having no `page` param at all.
export function claimScopeFor(item) {
  const p = item.params || {};
  const generatorId = item.generatorId || item.recommendation_type;
  if (generatorId === 'blog-outline' || generatorId === 'comparison-page') {
    return { scope: 'topic', scopeKey: p.topic || '' };
  }
  if (generatorId === 'landing-page') {
    return { scope: 'topic', scopeKey: p.topic || p.city || p.market || '' };
  }
  return { scope: 'page', scopeKey: p.page || item.page || '' };
}

// One call for a producer that has a recommendation-shaped item. Returns
// { ok: true } unchanged when the flag is off, so a call site reads the same
// whether or not enforcement is on.
export async function claimForItem(siteId, item, producer, { coverageStatus = null } = {}) {
  if (!isClaimsEnforcing()) return { ok: true, claimId: null, reason: 'disabled' };
  const { scope, scopeKey } = claimScopeFor(item);
  const generatorId = item.generatorId || item.recommendation_type || null;
  return claimWork({
    siteId, scope, scopeKey, producer, generatorId,
    intent: intentForGenerator(generatorId),
    coverageStatus,
  });
}

// Flips any expired open claim for this exact key, so a dead producer never
// permanently starves a live one. Targeted rather than table-wide: this runs
// on the hot path before every claim attempt.
async function expireKey(siteId, scope, scopeKey) {
  await query(
    `UPDATE work_claims SET status = 'expired', resolved_at = now()
      WHERE site_id = $1 AND scope = $2 AND scope_key = $3
        AND status = 'open' AND expires_at < now()`,
    [siteId, scope, scopeKey]
  );
}

async function openClaimFor(siteId, scope, scopeKey) {
  const { rows } = await query(
    `SELECT id, intent, producer, generator_id, recommendation_id, draft_id, created_at, expires_at
       FROM work_claims
      WHERE site_id = $1 AND scope = $2 AND scope_key = $3 AND status = 'open'
      LIMIT 1`,
    [siteId, scope, scopeKey]
  );
  return rows[0] ?? null;
}

export async function activeClaimFor(siteId, scope, scopeKey) {
  const key = normalizeScopeKey(scope, scopeKey);
  if (!key) return null;
  await expireKey(siteId, scope, key).catch(() => {});
  return openClaimFor(siteId, scope, key).catch(() => null);
}

// Takes the claim, or reports who holds it.
//
// Returns { ok: true, claimId } on success, { ok: false, reason, heldBy } when
// another producer owns it, and { ok: true, claimId: null, reason:
// 'unavailable' } when the ledger itself could not be reached — fail soft, so
// the caller proceeds exactly as it did before this table existed.
export async function claimWork({
  siteId, scope, scopeKey, intent, producer,
  generatorId = null, recommendationId = null, draftId = null,
  ttlHours = DEFAULT_TTL_HOURS, coverageStatus = null,
}) {
  if (!SCOPES.has(scope)) throw new Error(`work-claims: unknown scope "${scope}"`);
  if (!INTENTS.has(intent)) throw new Error(`work-claims: unknown intent "${intent}"`);

  const key = normalizeScopeKey(scope, scopeKey);
  // Nothing to key on means nothing to protect. Site-level work
  // (recommendationPageKey returns '' for SITE_LEVEL_GENERATOR_IDS) is not
  // claimable and must not all collide onto one empty-string owner.
  if (!key) return { ok: true, claimId: null, reason: 'unkeyed' };

  try {
    await expireKey(siteId, scope, key);

    // Atomic: the unique partial index decides. A loser's INSERT returns no
    // row, so there is no SELECT-then-INSERT window to race through.
    const { rows } = await query(
      `INSERT INTO work_claims
         (site_id, scope, scope_key, intent, producer, generator_id, recommendation_id, draft_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval)
       ON CONFLICT (site_id, scope, scope_key) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [siteId, scope, key, intent, producer, generatorId, recommendationId, draftId, ttlHours]
    );
    if (rows[0]) return { ok: true, claimId: rows[0].id };

    const heldBy = await openClaimFor(siteId, scope, key);
    // Lost the race and the holder vanished between the two statements:
    // treat as taken rather than retrying, and let the next run have it.
    if (!heldBy) return { ok: false, reason: 'contended', heldBy: null };

    const { winner, reason } = resolveIntentConflict({
      existingIntent: heldBy.intent, incomingIntent: intent, coverageStatus,
    });
    if (winner === 'existing') {
      return { ok: false, reason, heldBy };
    }

    // The newcomer outranks the incumbent. Supersede in one statement
    // conditioned on the holder's id, so a concurrent third producer cannot
    // also supersede the same row.
    const superseded = await query(
      `UPDATE work_claims SET status = 'superseded', resolved_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [heldBy.id]
    );
    if (!superseded.rows[0]) return { ok: false, reason: 'contended', heldBy };

    const retaken = await query(
      `INSERT INTO work_claims
         (site_id, scope, scope_key, intent, producer, generator_id, recommendation_id, draft_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval)
       ON CONFLICT (site_id, scope, scope_key) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [siteId, scope, key, intent, producer, generatorId, recommendationId, draftId, ttlHours]
    );
    if (!retaken.rows[0]) return { ok: false, reason: 'contended', heldBy };
    return { ok: true, claimId: retaken.rows[0].id, reason, superseded: heldBy.id };
  } catch (err) {
    console.error('[work-claims] claim failed, proceeding unclaimed:', err.message);
    return { ok: true, claimId: null, reason: 'unavailable' };
  }
}

// Called when the work finishes, is abandoned, or is superseded upstream.
// `status` is 'done' for work that actually happened and 'released' for work
// the producer decided not to do — the distinction matters when reading the
// ledger to see whether claiming is blocking real output.
export async function releaseClaim(claimId, status = 'done') {
  if (!claimId) return;
  await query(
    `UPDATE work_claims SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'open'`,
    [claimId, status]
  ).catch((err) => console.error('[work-claims] release failed:', err.message));
}

// Table-wide sweep for the hourly reconcile lane. The per-key sweep in
// claimWork handles the hot path; this one catches keys nobody has asked
// about since their holder died.
export async function expireStaleClaims() {
  const { rows } = await query(
    `UPDATE work_claims SET status = 'expired', resolved_at = now()
      WHERE status = 'open' AND expires_at < now()
      RETURNING id`
  ).catch((err) => {
    console.error('[work-claims] expiry sweep failed:', err.message);
    return { rows: [] };
  });
  return rows.length;
}
