import { query } from '../../db.js';
import { classifyAbandonReason, RETRY_POLICY } from '../../lib/attempt-classification.js';

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

// 'infra' is the same kind of non-verdict as 'refused': logged in full, but
// scored neither way. It exists because the shipping loop's 'failed' branch
// could not tell "this generator produced something unusable" from "GitHub
// was rate-limited", "the shared batch PR failed for all 54 items at once",
// "the citation provider was out of quota", or "a human sent the draft back"
// — and recorded all of them identically as this generator's own failure.
//
// The convergence cap (store/drafts.js's countFailedAttemptsByFinding) had
// always excluded exactly these causes; this scorer had not, so the two
// disagreed about what a failure even was. Measured on site 1, 2026-09-04:
// of 42 failures in the live scoring window, 3 were genuine, and the other
// 39 had demoted SEVEN generators covering 398 open recommendations — 70% of
// the backlog — while the daily budget sat at 5 of 60 used.
//
// Attribution is decided by lib/attempt-classification.js, the module the
// convergence cap already uses, so the two can no longer drift apart.
export const NON_SCORING = new Set(['refused', 'infra']);

// A recorded outcome is this generator's own fault only when the reason
// classifies as a real, item-specific defect. Everything else — transient
// infrastructure, a config gap a human must close, a human's own decision,
// work another draft already did — is logged as 'infra' instead.
//
// 'rejected' is re-attributed on the same rule as 'failed', because not every
// rejected row is a human's verdict. A human's own reject click records their
// free-text reason, which classifies as ITEM_DEFECT (the default) and so stays
// 'rejected' — a real negative signal, correctly kept. But the reconciler
// writes the SENTINEL 'sent_back_to_recommendations' (action-center-
// reconciler.js's RECLAIM_REASON) through the same outcome, and that means
// only "the attempt was withdrawn and returned to the board". Those eight
// sentinel rows alone were still demoting alt-text, broken-link-fix and
// schema-repair after the failure-side fix, holding 43 more recommendations.
//
// An outcome with NO detail at all is left alone: we cannot attribute what we
// cannot read, and this file's existing stance (see MIN_SAMPLES) is that an
// unexplained negative is real until evidence says otherwise.
const ATTRIBUTABLE = new Set(['failed', 'rejected']);

export function attributeOutcome(outcome, detail) {
  if (!ATTRIBUTABLE.has(outcome)) return outcome;
  const text = typeof detail === 'string' ? detail.trim() : '';
  if (!text) return outcome;
  return classifyAbandonReason(text).retryPolicy === RETRY_POLICY.ITEM_DEFECT ? outcome : 'infra';
}

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
    // Attributed HERE rather than at each call site so no future caller can
    // reintroduce the misattribution by recording a raw 'failed' — there are
    // two such call sites in auto-remediation.js alone, and the batch one
    // (finalizeBatchPr) fails every pending item in the batch at once.
    const attributed = attributeOutcome(outcome, detail);
    await query(
      `INSERT INTO generator_outcomes (site_id, generator_id, outcome, recommendation_id, draft_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [siteId, generatorId, attributed, recommendationId, draftId, detail]
    );
  } catch (err) {
    console.error(`[generator-learning] could not record outcome for site ${siteId}/${generatorId}:`, err.message);
  }
}

// recommendation_id -> how many times this exact recommendation has been
// refused inside the window, for ship-pacing.js's refusal cap.
//
// Refusals are deliberately excluded from the learned score above and from
// the convergence cap (store/drafts.js counts abandoned DRAFTS, and a refusal
// never produces one), which between them left a refusing item with no brake
// at all. Confirmed live on site 1: one direct-answer recommendation had
// refused 22 times and was still being re-drafted every hour, and because the
// eligible pool had collapsed to exactly one candidate it was consuming the
// entire run, every run.
// Only refusals the ITEM itself caused are counted. A refusal recorded
// because an EXTERNAL dependency was unavailable — 'citation-grounding-
// unavailable' when Tavily is down or past its daily query cap — says
// nothing about the item and must never retire it: site 1 has 92 open
// external-citations recommendations, and counting quota refusals would
// permanently retire all of them after five days of hitting the cap, which
// is the same misattribution this module was just fixed for on the failure
// side. Classified through lib/attempt-classification.js so the failure and
// refusal paths share one definition of "the item's own fault".
export async function countRefusalsByRecommendation(siteId, { windowDays = 30 } = {}) {
  const { rows } = await query(
    `SELECT recommendation_id, detail
       FROM generator_outcomes
      WHERE site_id = $1 AND outcome = 'refused' AND recommendation_id IS NOT NULL
        AND created_at > now() - make_interval(days => $2)`,
    [siteId, windowDays]
  );
  const counts = new Map();
  for (const row of rows) {
    // A refusal with no recorded reason counts: unattributable, so treated as
    // real, the same stance attributeOutcome takes for a detail-less failure.
    const text = typeof row.detail === 'string' ? row.detail.trim() : '';
    if (text && classifyAbandonReason(text).retryPolicy !== RETRY_POLICY.ITEM_DEFECT) continue;
    counts.set(row.recommendation_id, (counts.get(row.recommendation_id) || 0) + 1);
  }
  return counts;
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
        successes: 0, failures: 0, refused: 0, infra: 0, total: 0,
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
    // 'infra' counted in its OWN bucket rather than swept into `refused` by
    // the catch-all: both are non-scoring, but they mean different things to
    // a human reading why a generator is or isn't trusted, and collapsing
    // them would hide the platform problems this attribution exists to
    // surface. NON_SCORING names the pair so the distinction is explicit
    // instead of implied by fall-through order.
    else if (row.outcome === 'infra') bucket.infra++;
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
