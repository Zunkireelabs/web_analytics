import { hasRecentDraftOfType, countFailedAttemptsByFinding } from '../../store/drafts.js';
import { countRecoveryCyclesByFinding, countRefusalRecoveryCyclesByRecommendation } from '../../store/recommendation-attempts.js';
import { countRefusalsByRecommendation } from './generator-learning.js';

// Candidate thinning shared by BOTH ship paths — auto-remediation.js's
// unattended cron run and routes/action-center.js's executeSafeFixes ("Execute
// Today's Safe Fixes"). It lives in its own module precisely because those two
// already import each other; hanging shared logic off either one would deepen
// an existing cycle.
//
// This is not a refactor for tidiness. Both rules below existed only on the
// cron path, and the manual bulk path — which is where the volume actually
// comes from — had neither. On 2026-09-01 three back-to-back bulk runs
// produced 61 blog-outline drafts in one day and opened a single PR carrying
// 42 net-new blog posts, while the cron path's own pacing rule sat right
// there, correctly limiting itself to one per run.

// Generators that publish net-new content on a cadence rather than fixing an
// existing page, and so are paced instead of merely budgeted. The daily
// budget answers "how much work per day"; this answers "how often does this
// KIND of work happen at all" — a distinction the budget alone can't make,
// since 28 open blog-outline recommendations are 28 legitimate candidates as
// far as it is concerned.
//
// Two rules per entry, both needed:
//   - at most ONE per run, so a single day can't publish a burst; and
//   - none at all if one was published inside the site's gap window.
// The first without the second would still allow one blog every single day.
//
// Paced items are NOT given a separate allowance — the one that survives
// competes for the same budget slot as every ordinary fix, which is what
// keeps "30 a day" a single honest number.
export const PACED_GENERATORS = [
  { generatorId: 'blog-outline', gapColumn: 'blog_min_gap_days', defaultGapDays: 3 },
];

// How many times a finding may be drafted and abandoned for a real,
// item-specific failure before it stops being re-attempted automatically.
//
// Three, not one: the first failure can genuinely be bad luck (a transient
// upstream, a page mid-deploy), and a second attempt converging is a real,
// observed outcome. A THIRD identical failure is not bad luck — every
// repeat-offender on site 1 failed for a stable config reason ("No markers
// configured for ...", "No url_file_map entry matches ...", "already has an
// FAQPage schema"), which no number of retries resolves because the fix is
// in configuration, not in generation.
//
// Deliberately not zero-tolerance and deliberately not permanent: the
// recommendation stays OPEN and fully visible in the Action Center, and a
// human can still generate it by hand. What stops is the automatic
// redrafting AGAINST THE SAME EVIDENCE — the loop that was spending a model
// call per cycle to reach the same error.
//
// "Against the same evidence" is the operative phrase since 2026-09-06:
// this cap alone used to mean "give up after 3 and tell a human" — but for
// an ITEM_DEFECT failure (a stale anchor, a moved target) 3 identical
// retries genuinely tell you nothing more than 1 does, because every retry
// used the exact same frozen params. lib/action-center-reconciler.js now
// treats hitting this cap as the trigger to autonomously RE-DETECT the
// finding against live content and refresh those params (recordAttempt
// outcome='recovered', migration 142) rather than escalate immediately — see
// MAX_RECOVERY_CYCLES below for the bound on how many times that itself is
// allowed to happen before NEEDS_HUMAN is the true, exhausted fallback.
export const MAX_FAILED_ATTEMPTS = 3;

// How many times a finding may go through a full autonomous recovery cycle
// (re-detect against live content, refresh params, try again) before the
// system accepts it genuinely cannot determine or validate a fix on its own
// and hands it to a human. Each cycle earns the finding another
// MAX_FAILED_ATTEMPTS worth of tries on fresh evidence — see
// effectiveConvergenceCap below — so the total autonomous budget before
// NEEDS_HUMAN is MAX_FAILED_ATTEMPTS * (MAX_RECOVERY_CYCLES + 1) attempts,
// spread across that many independently-evidenced approaches, not one.
//
// Bounded rather than infinite for the same reason MAX_FAILED_ATTEMPTS is:
// an item whose page keeps changing in a way that never satisfies the
// generator (a template bug, a genuinely ambiguous target) will re-detect
// "still broken" forever, and re-detecting is not free — each cycle costs a
// live agent run plus another generation attempt. Two cycles is enough to
// distinguish "the page settled and this converges" from "this needs a
// human's judgment", without turning a stuck item into an unbounded loop of
// re-analysis instead of an unbounded loop of retries.
export const MAX_RECOVERY_CYCLES = 2;

// The real, current ceiling for one finding's attempts, accounting for
// however many recovery cycles it has already earned. The single formula
// both applyConvergenceCap (below, "should this still be auto-drafted") and
// the reconciler ("has autonomous recovery been exhausted") must agree on —
// diverging here would mean ship-pacing silently excludes a finding the
// reconciler still considers eligible for another try, or the reverse.
export function effectiveConvergenceCap(recoveryCycles) {
  return MAX_FAILED_ATTEMPTS * ((recoveryCycles || 0) + 1);
}

// Drops paced candidates that this site isn't due for yet, and thins the rest
// to one each. Returns the candidates in their original priority order, plus
// the human-readable notes the caller logs — deferrals are never silent, the
// same rule the daily budget's truncation already follows.
export async function applyPacing(site, candidates, { recentDraftCheck = hasRecentDraftOfType } = {}) {
  const timezone = site.timezone || 'UTC';
  const notes = [];
  const dropped = new Set();

  for (const { generatorId, gapColumn, defaultGapDays } of PACED_GENERATORS) {
    const matching = candidates.filter((r) => r.recommendation_type === generatorId);
    if (matching.length === 0) continue;

    const gapDays = site[gapColumn] ?? defaultGapDays;

    // A blog someone explicitly asked for on the Analyst page ("write a blog
    // on this keyword?") is a request, not the agent's own choice of what to
    // publish next — so the cadence gap, which exists to stop the agent
    // publishing on its own initiative too often, does not apply to it. What
    // DOES still apply is the one-per-run rule below: a client clicking Yes on
    // three keywords gets three blogs on three consecutive days, never three
    // at once. Requested items also win the single slot outright, so a pending
    // request is never postponed behind an agent-chosen topic.
    const requested = matching.filter((r) => r.params?.clientRequested === true);
    if (requested.length > 0) {
      for (const r of matching) if (r.id !== requested[0].id) dropped.add(r.id);
      const heldNote = matching.length > 1 ? ` ${matching.length - 1} other candidate(s) wait for a later run.` : '';
      notes.push(`${generatorId}: shipping 1 explicitly requested topic ("${requested[0].params?.topic ?? 'unknown'}") — the ${gapColumn}=${gapDays} cadence gap does not apply to a requested blog.${heldNote}`);
      continue;
    }

    if (await recentDraftCheck(site.id, generatorId, gapDays, timezone)) {
      for (const r of matching) dropped.add(r.id);
      notes.push(`${generatorId}: ${matching.length} candidate(s) held — one was published within the last ${gapDays} day(s) (${gapColumn}=${gapDays}).`);
      continue;
    }
    // Due: keep the highest-priority one (candidates arrive in
    // listOpenRecommendations' order), defer the rest to future runs.
    for (const r of matching.slice(1)) dropped.add(r.id);
    if (matching.length > 1) {
      notes.push(`${generatorId}: taking 1 of ${matching.length} open candidate(s); the rest wait for the next ${gapDays}-day slot.`);
    }
  }

  return { paced: candidates.filter((r) => !dropped.has(r.id)), notes };
}

/**
 * Drops candidates whose finding has already failed MAX_FAILED_ATTEMPTS times
 * for an item-specific reason. Same shape as applyPacing so a caller applies
 * both the same way.
 *
 * A recommendation can carry several finding_ids; the highest attempt count
 * among them decides, since one permanently-unfixable component is enough to
 * make the whole recommendation fail the same way every time.
 */
// How many times one recommendation may be REFUSED before it stops being
// auto-drafted. The refusal counterpart to MAX_FAILED_ATTEMPTS, and
// deliberately looser: a refusal is the no-fabrication policy working
// correctly, and unlike a failure it can legitimately start succeeding when
// the page's own content changes, so it earns more attempts before being set
// aside.
//
// Something had to bound it, though. A refusal is excluded from the learned
// score (generator-learning.js) AND invisible to the convergence cap (which
// counts abandoned drafts, and a refusal never creates one), so a refusing
// item previously had no brake whatsoever. The measured result on site 1: one
// direct-answer recommendation refused 22 times and was still being
// re-attempted every hour — and once the demotion bug had collapsed the
// eligible pool to a single candidate, that one item was the ENTIRE content
// of five consecutive runs.
//
// Like the convergence cap, this never closes or hides anything: the
// recommendation stays open and a human can still generate it by hand. What
// stops is spending a model call per run to reach the same honest refusal.
export const MAX_REFUSALS = 5;

// The refusal counterpart to MAX_RECOVERY_CYCLES/effectiveConvergenceCap
// above — until this existed, MAX_REFUSALS was a permanent hold with no way
// back: countRefusalsByRecommendation only ever sees refusals, and
// applyRefusalCap filters a held item out of every future candidate list
// before the generate/push loop can ever attempt it again, so a refusal
// caused by a now-resolved transient condition (confirmed live: GitHub rate
// limiting during the exact window that produced most of site 1's held
// broken-link-fix refusals) sat re-classified as a permanent defect forever,
// identically to a genuinely unfixable one. driveAutonomousRefusalRecovery
// (action-center-reconciler.js) is what actually spends a cycle — one real,
// fresh attempt against live evidence per cycle, same "earn it, don't assume
// it" discipline the convergence cap already uses.
export const MAX_REFUSAL_RECOVERY_CYCLES = 2;

// The real, current refusal ceiling once however many recovery cycles have
// already been earned — same formula shape as effectiveConvergenceCap,
// kept as its own function (not a shared one) because the two caps count
// two structurally different things (recommendation-scoped refusals vs.
// finding-scoped failures) from two different queries.
export function effectiveRefusalCap(recoveryCycles) {
  return MAX_REFUSALS * ((recoveryCycles || 0) + 1);
}

/**
 * Drops candidates that have already been refused past their current
 * effective cap. Same shape as applyPacing/applyConvergenceCap so a caller
 * applies all three the same way.
 */
export async function applyRefusalCap(site, candidates, { refusalCounts = null, recoveryCounts = null } = {}) {
  if (candidates.length === 0) return { kept: candidates, notes: [] };
  const counts = refusalCounts ?? await countRefusalsByRecommendation(site.id);
  if (counts.size === 0) return { kept: candidates, notes: [] };
  // Only fetched when there's actually a held candidate to raise the cap
  // for — a site with no refusals never needs its recovery history either.
  const recoveries = recoveryCounts ?? await countRefusalRecoveryCyclesByRecommendation(site.id);

  const notes = [];
  const kept = [];
  for (const rec of candidates) {
    const refusals = counts.get(rec.id) || 0;
    const cycles = recoveries.get(rec.id) || 0;
    const cap = effectiveRefusalCap(cycles);
    if (refusals >= cap) {
      // Held here means "wait for the reconciler's next pass" — it either
      // raises this very cap by spending a fresh recovery cycle (if any
      // remain) or, once MAX_REFUSAL_RECOVERY_CYCLES is spent, hands the
      // card to a human. Never a dead end on its own.
      notes.push(`${rec.recommendation_type} #${rec.id}: held after ${refusals} honest refusal(s) (cap ${cap} after ${cycles} recovery cycle(s)) — awaiting autonomous re-analysis or a human.`);
      continue;
    }
    kept.push(rec);
  }
  return { kept, notes };
}

export async function applyConvergenceCap(site, candidates, { attemptCounts = null, recoveryCounts = null } = {}) {
  if (candidates.length === 0) return { converged: candidates, notes: [] };
  const counts = attemptCounts ?? await countFailedAttemptsByFinding(site.id);
  if (counts.size === 0) return { converged: candidates, notes: [] };
  // Only fetched when there's actually something to hold — a site with no
  // failed attempts never needs its recovery history either.
  const recoveries = recoveryCounts ?? await countRecoveryCyclesByFinding(site.id);

  const notes = [];
  const kept = [];
  for (const rec of candidates) {
    const findingIds = rec.finding_ids || [];
    const attempts = findingIds.reduce((max, id) => Math.max(max, counts.get(id) || 0), 0);
    const cycles = findingIds.reduce((max, id) => Math.max(max, recoveries.get(id) || 0), 0);
    const cap = effectiveConvergenceCap(cycles);
    if (attempts >= cap) {
      // Held here means "wait for the reconciler's next pass" — it either
      // raises this very cap by re-detecting and refreshing params (another
      // recovery cycle, if any remain) or, once MAX_RECOVERY_CYCLES is spent,
      // hands the card to a human. Never a dead end on its own.
      notes.push(`${rec.recommendation_type} #${rec.id}: held after ${attempts} failed attempt(s) (cap ${cap} after ${cycles} recovery cycle(s)) — awaiting autonomous re-analysis or a human.`);
      continue;
    }
    kept.push(rec);
  }
  return { converged: kept, notes };
}
