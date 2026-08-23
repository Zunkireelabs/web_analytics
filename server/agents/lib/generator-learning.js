import { query } from '../../db.js';

// Phase 5: the system learns from outcomes instead of making the same
// decision forever, without becoming machine-learning infrastructure.
//
// The whole mechanism is: log a plain outcome when one becomes known (§Phase
// 5 goal), then read a bounded trailing window and score it on demand. There
// is no separate "confidence" value kept in sync by an update path — that
// would be a second source of truth that can drift from the log itself. A
// score computed fresh from real rows can never disagree with its own
// evidence.

// 'refused' deliberately excluded from both success and failure — a
// principled refusal (auto-remediation.js's own no-fabrication policy
// firing) says nothing about whether the generator is trustworthy. Counting
// it either way would punish or reward the generator for behaving correctly.
const POSITIVE = new Set(['shipped', 'merged']);
const NEGATIVE = new Set(['failed', 'rejected']);

// A SEPARATE signal from the technical POSITIVE/NEGATIVE above — "did it
// ship/merge" and "did it move the metric" are different questions (see
// fix-impact.js, which is the only writer of these three values) and are
// never mixed into the same ratio, so a generator that reliably ships
// technically-valid fixes with weak real-world impact is still visible as
// two distinct numbers, not one blended one. 'impact-neutral' is excluded
// from the ratio for the same reason 'refused' is excluded above — a
// neutral measurement says nothing about whether the generator's impact is
// trustworthy, it would just dilute the ratio toward 0.5 for a generator
// that is neither helping nor hurting.
const IMPACT_POSITIVE = new Set(['impact-positive']);
const IMPACT_NEGATIVE = new Set(['impact-negative']);

// Never blocks or fails the caller — every call site is on a real execution
// path (the auto-remediation loop, a human's reject click, a PR merging) and
// learning must never be why a real action failed. A logging failure is
// itself logged and swallowed.
export async function recordOutcome(siteId, generatorId, outcome, { recommendationId = null, draftId = null, detail = null } = {}) {
  try {
    await query(
      `INSERT INTO generator_outcomes (site_id, generator_id, outcome, recommendation_id, draft_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [siteId, generatorId, outcome, recommendationId, draftId, detail]
    );
  } catch (err) {
    console.error(`[generator-learning] could not record outcome for site ${siteId}/${generatorId}:`, err.message);
  }
}

// How many samples before a score is trusted at all. Below this, one bad
// early attempt could swing a raw ratio to 0% — not evidence of anything yet,
// just noise from a small sample.
const MIN_SAMPLES = 3;
// Demote to human review once failures/rejections meaningfully outnumber
// successes within the trailing window — not on the first failure (that is
// what the circuit breaker and refusal handling already cover per-run) but
// once a PATTERN is evident across runs.
const DEMOTE_FAILURE_RATIO = 0.4;
// Bounded window, not the whole history — an old streak of failures a
// generator has since been fixed for should not haunt it forever, and an
// unbounded query cost grows with the site's whole lifetime otherwise.
const WINDOW_SIZE = 30;

// One row per generator this site has real history for, in one query — the
// shape autonomy-decision.js's classifyRecommendation and summarizeAutonomy
// take as an optional parameter, so a caller acting on many recommendations
// at once (the common case) never issues one query per item.
export async function getLearnedConfidenceMap(siteId) {
  const { rows } = await query(
    `SELECT generator_id, outcome, created_at FROM (
       SELECT generator_id, outcome, created_at,
              row_number() OVER (PARTITION BY generator_id ORDER BY created_at DESC) AS rn
       FROM generator_outcomes WHERE site_id = $1
     ) windowed WHERE rn <= $2`,
    [siteId, WINDOW_SIZE]
  );

  const byGenerator = new Map();
  for (const row of rows) {
    if (!byGenerator.has(row.generator_id)) {
      byGenerator.set(row.generator_id, {
        successes: 0, failures: 0, refused: 0, total: 0,
        impactPositive: 0, impactNegative: 0, impactNeutral: 0,
      });
    }
    const bucket = byGenerator.get(row.generator_id);
    bucket.total++;
    if (POSITIVE.has(row.outcome)) bucket.successes++;
    else if (NEGATIVE.has(row.outcome)) bucket.failures++;
    else if (IMPACT_POSITIVE.has(row.outcome)) bucket.impactPositive++;
    else if (IMPACT_NEGATIVE.has(row.outcome)) bucket.impactNegative++;
    else if (row.outcome === 'impact-neutral') bucket.impactNeutral++;
    else bucket.refused++;
  }

  const result = new Map();
  for (const [generatorId, b] of byGenerator) {
    const scored = b.successes + b.failures; // refusals excluded from the denominator too, for the same reason they're excluded from scoring
    const hasEnoughSamples = scored >= MIN_SAMPLES;
    const failureRatio = scored ? b.failures / scored : 0;

    // Same statistical treatment as the technical ratio above (MIN_SAMPLES,
    // bounded window, recomputed live every call — never stored/stale), but
    // a SEPARATE number: never blended with `confidence`, and — per the
    // product decision this exists under — this is informational only, it
    // never demotes/blocks a generator on its own (see auto-remediation.js,
    // the one place it is actually consumed, where it only tempers a
    // ranking score, the same non-blocking role `confidence` already
    // plays there). Note the shared 30-row window above is partitioned by
    // generator_id across BOTH outcome families, not separately per family
    // — a generator with many technical outcomes and few (slower-arriving,
    // 28-day-delayed) impact outcomes may often show insufficient-data here
    // even with a long history; that's the correct fail-safe default, not a
    // bug to work around with a second query.
    const impactScored = b.impactPositive + b.impactNegative;
    const hasEnoughImpactSamples = impactScored >= MIN_SAMPLES;

    result.set(generatorId, {
      ...b,
      confidence: hasEnoughSamples ? Number((b.successes / scored).toFixed(2)) : null,
      impactConfidence: hasEnoughImpactSamples ? Number((b.impactPositive / impactScored).toFixed(2)) : null,
      // Only a real, evidenced pattern demotes — not a single sample.
      demote: hasEnoughSamples && failureRatio >= DEMOTE_FAILURE_RATIO,
      reason: hasEnoughSamples && failureRatio >= DEMOTE_FAILURE_RATIO
        ? `${b.failures} of ${scored} recent attempts failed or were rejected — held for review until this improves`
        : null,
    });
  }
  return result;
}
