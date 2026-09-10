import { query } from '../../db.js';

// Extends generator-learning.js's "learn from real outcomes" principle to
// the TOPIC level — the multi-tenant growth spec's "must continuously learn
// ... what actually gained impressions/clicks/rankings" and feed it back
// into which opportunities get pursued, not just whether a generator is
// technically reliable. generator-learning.js already answers "is
// blog-outline trustworthy"; this answers "has a commercial/direct-relevance
// content-gap actually been worth shipping on THIS site" — the one
// dimension createActionCenterRecommendationForGap already uses to boost
// priority, so it's the one worth closing the loop on first.
//
// Deliberately reuses generator_outcomes (no new outcome table): every
// content-gap-sourced recommendation already writes there via the exact
// same fix-impact.js / auto-remediation.js paths every other generator
// uses. The only new work here is joining back through
// recommendations.finding_ids ('keyword-gap:<id>') to the gap's own real
// search_intent/product_relevance — both already classified once, for
// free, at approval time (classifyGapRelevance).

const POSITIVE = new Set(['shipped', 'merged']);
const NEGATIVE = new Set(['failed', 'rejected']);
const IMPACT_POSITIVE = new Set(['impact-positive']);
const IMPACT_NEGATIVE = new Set(['impact-negative']);

const MIN_SAMPLES = 3;
const WINDOW_DAYS = 180;

// One row per (search_intent, product_relevance) bucket this site has real
// shipped-content-gap history for. Never blocks a caller on failure — same
// "learning must never break a real action" stance as generator-learning.js.
export async function getLearnedGapConfidence(siteId) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT g.search_intent, g.product_relevance, go.outcome
         FROM generator_outcomes go
         JOIN recommendations r ON r.id = go.recommendation_id
         JOIN LATERAL unnest(r.finding_ids) AS fid(finding_id) ON fid.finding_id LIKE 'keyword-gap:%'
         JOIN keyword_gaps g ON g.id = substring(fid.finding_id FROM 'keyword-gap:(\\d+)')::int AND g.site_id = go.site_id
        WHERE go.site_id = $1 AND go.created_at > now() - make_interval(days => $2)
          AND g.search_intent IS NOT NULL AND g.product_relevance IS NOT NULL`,
      [siteId, WINDOW_DAYS]
    ));
  } catch (err) {
    console.error(`[gap-learning] could not read learned gap confidence for site ${siteId}:`, err.message);
    return new Map();
  }

  const byBucket = new Map();
  for (const row of rows) {
    const key = `${row.search_intent}:${row.product_relevance}`;
    if (!byBucket.has(key)) byBucket.set(key, { successes: 0, failures: 0, impactPositive: 0, impactNegative: 0 });
    const b = byBucket.get(key);
    if (POSITIVE.has(row.outcome)) b.successes++;
    else if (NEGATIVE.has(row.outcome)) b.failures++;
    else if (IMPACT_POSITIVE.has(row.outcome)) b.impactPositive++;
    else if (IMPACT_NEGATIVE.has(row.outcome)) b.impactNegative++;
  }

  const result = new Map();
  for (const [key, b] of byBucket) {
    const impactScored = b.impactPositive + b.impactNegative;
    const shippedScored = b.successes + b.failures;
    result.set(key, {
      ...b,
      // Whether real post-publish GSC impact ever materialized for this
      // bucket — this is the number that should temper "commercial +
      // direct-relevance always gets boosted to high priority", not just
      // "did it technically ship".
      impactConfidence: impactScored >= MIN_SAMPLES ? Number((b.impactPositive / impactScored).toFixed(2)) : null,
      shipConfidence: shippedScored >= MIN_SAMPLES ? Number((b.successes / shippedScored).toFixed(2)) : null,
    });
  }
  return result;
}

// Below this, the priority boost is withheld even though intent/relevance
// alone would otherwise justify it — not a demotion, just "not yet proven",
// same non-punitive stance generator-learning.js takes on a thin sample.
const LOW_IMPACT_THRESHOLD = 0.35;

// The one real decision this module drives today: was boosting this
// site's own commercial+direct gaps to 'high' priority actually right, or
// has this site's real GSC evidence said otherwise enough times to stop
// assuming it? Returns the ORIGINAL boosted value unless there is a real,
// evidenced pattern saying not to — never invents a downgrade from thin data.
export function temperPriorityBoost(learnedMap, searchIntent, productRelevance, boostedPriority) {
  if (!boostedPriority) return boostedPriority;
  const bucket = learnedMap.get(`${searchIntent}:${productRelevance}`);
  if (bucket?.impactConfidence != null && bucket.impactConfidence < LOW_IMPACT_THRESHOLD) return undefined;
  return boostedPriority;
}
