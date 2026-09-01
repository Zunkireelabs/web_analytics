import { hasRecentDraftOfType, countFailedAttemptsByFinding } from '../../store/drafts.js';

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
// redrafting — the loop that was spending a model call per cycle to reach
// the same error.
export const MAX_FAILED_ATTEMPTS = 3;

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
export async function applyConvergenceCap(site, candidates, { attemptCounts = null } = {}) {
  if (candidates.length === 0) return { converged: candidates, notes: [] };
  const counts = attemptCounts ?? await countFailedAttemptsByFinding(site.id);
  if (counts.size === 0) return { converged: candidates, notes: [] };

  const notes = [];
  const kept = [];
  for (const rec of candidates) {
    const findingIds = rec.finding_ids || [];
    const attempts = findingIds.reduce((max, id) => Math.max(max, counts.get(id) || 0), 0);
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      notes.push(`${rec.recommendation_type} #${rec.id}: held after ${attempts} failed attempt(s) on the same finding — still open for a human, but no longer auto-drafted.`);
      continue;
    }
    kept.push(rec);
  }
  return { converged: kept, notes };
}
