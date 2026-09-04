import { severityTierFor, severityTierLabel, SEVERITY_TIER } from './severity-tiers.js';
import { ctrAtPosition, opportunityScore, estimatedTrafficGain, TARGET_POSITION } from './opportunity-scoring.js';

// Scores one recommendation by how much organic growth acting on it is
// likely to produce, so the daily run can attempt the 60 BEST eligible items
// rather than the first 60 in table order.
//
// Every component below is a real, already-computed number — measured GSC
// metrics, the site's own open backlog, this generator's own outcome history.
// Nothing is estimated by a model and nothing invents an SEO constant: the
// CTR curve, position factor and traffic-gain maths are imported from
// opportunity-scoring.js, which the Growth Opportunities view already uses.
//
// THE THIN-DATA CONSTRAINT, which shapes the whole design: most pages have no
// GSC data at all. On the reference site 47 pages had any impressions in 28
// days against a backlog spanning 94+ distinct pages. So demand can only ever
// ADD to a score, never gate one — a scorer that multiplied by impressions
// would collapse ~80% of the backlog to zero and rank it arbitrarily, which
// is the failure mode this module exists to replace. A page with no measured
// demand still earns its severity, breadth and confidence score in full.

// Tier dominates. Ordering must be "every critical indexing fault, then
// on-page work", not "a high-traffic cosmetic tweak outranks a noindex bug",
// so tiers are separated by a gap no within-tier bonus can bridge: the
// within-tier components below are bounded well under STEP.
const STEP = 1000;
const tierBase = (tier) => (6 - tier) * STEP;

// ── Within-tier components (bounded, so they re-order inside a tier only) ──

// Real measured demand for the page this recommendation targets. Bounded to
// ~300 so it can lift an item within its tier without crossing STEP.
//
// Three distinct opportunities, because they are genuinely different: raw
// visibility (impressions), rank close enough to page 1 to be worth pushing,
// and impressions that are not converting to clicks at the rank they already
// hold. A page can qualify for more than one.
const DEMAND_CAP = 300;

// Ceiling on the decline bonus. Set above DEMAND_CAP on purpose: a page
// actively losing 800 impressions must be able to outrank a healthy page
// sitting at a high but stable level, which is the entire behaviour change.
// Capped all the same, so one catastrophic page cannot claim the whole day.
const DECLINE_CAP = 600;
export function demandScore(metrics) {
  if (!metrics || !metrics.impressions) return { score: 0, factors: [] };
  const { impressions, avgPosition, ctr } = metrics;
  const factors = [];
  let score = 0;

  // Visibility, log-scaled: the difference between 10 and 100 impressions
  // matters far more than between 10,000 and 10,090, and on a small site
  // linear scaling would let one outlier page dominate every ranking.
  const visibility = Math.min(100, Math.log10(1 + impressions) * 33);
  score += visibility;
  factors.push(`impressions=${impressions} (+${visibility.toFixed(0)})`);

  if (avgPosition != null) {
    // Distance to page 1 — opportunityScore already weights impressions by
    // how reachable the target position is.
    if (avgPosition > 10 && avgPosition <= 20) {
      const near = Math.min(100, opportunityScore(impressions, avgPosition, 10, 20) / 10);
      score += near;
      factors.push(`near-page-1 (pos ${avgPosition}, +${near.toFixed(0)})`);
    }
    // Already ranking but under-clicked for that rank: the cheapest real
    // traffic on the site, since the ranking work is already done.
    const expectedCtr = ctrAtPosition(avgPosition);
    if (avgPosition <= 10 && expectedCtr > 0 && ctr < expectedCtr * 0.6) {
      const gain = Math.min(100, estimatedTrafficGain(impressions, ctr, ctrAtPosition(TARGET_POSITION)) * 2);
      score += gain;
      factors.push(`ctr-gap (pos ${avgPosition}, ctr ${(ctr * 100).toFixed(1)}% vs ${(expectedCtr * 100).toFixed(1)}% expected, +${gain.toFixed(0)})`);
    }
  }

  const capped = Math.min(DEMAND_CAP, score);
  return { score: capped, factors };
}

// How many distinct problems this one fix resolves. A template fault across
// 20 pages is genuinely worth more than the same fault on one page, and a
// root-cause group is worth more than any single symptom in it.
const BREADTH_CAP = 200;
export function breadthScore(rec, groupSize = 1) {
  const factors = [];
  let score = 0;

  if (groupSize > 1) {
    // Sub-linear: 20 co-located problems are worth more than 2, but not 10x,
    // or one large group would monopolise the tier.
    const bonus = Math.min(120, Math.log2(groupSize) * 40);
    score += bonus;
    factors.push(`root-cause group of ${groupSize} (+${bonus.toFixed(0)})`);
  }
  const findings = rec.finding_ids?.length || 0;
  if (findings > 1) {
    const bonus = Math.min(50, (findings - 1) * 10);
    score += bonus;
    factors.push(`${findings} findings merged (+${bonus.toFixed(0)})`);
  }
  // Independent agents agreeing that the same thing is wrong is real
  // corroboration, and already recorded.
  const supporting = rec.supporting_agents?.length || 0;
  if (supporting > 0) {
    const bonus = Math.min(30, supporting * 15);
    score += bonus;
    factors.push(`${supporting} corroborating agent(s) (+${bonus.toFixed(0)})`);
  }

  return { score: Math.min(BREADTH_CAP, score), factors };
}

// This generator's own measured track record. Both values are already
// computed by generator-learning.js over real outcomes and are 0-1, or null
// below 3 scored samples — null is treated as neutral (no adjustment), never
// as a penalty, so a new generator is not buried before it has a history.
const CONFIDENCE_SWING = 150;
export function confidenceScore(rec, learned) {
  if (!learned) return { score: 0, factors: [] };
  const factors = [];
  let score = 0;
  if (typeof learned.confidence === 'number') {
    const adj = (learned.confidence - 0.5) * CONFIDENCE_SWING;
    score += adj;
    factors.push(`ships-successfully ${(learned.confidence * 100).toFixed(0)}% (${adj >= 0 ? '+' : ''}${adj.toFixed(0)})`);
  }
  if (typeof learned.impactConfidence === 'number') {
    const adj = (learned.impactConfidence - 0.5) * CONFIDENCE_SWING;
    score += adj;
    factors.push(`measured-impact ${(learned.impactConfidence * 100).toFixed(0)}% (${adj >= 0 ? '+' : ''}${adj.toFixed(0)})`);
  }
  return { score, factors };
}

// expected_impact.LABEL only — never .value. The label ('High'/'Medium'/'Low')
// is the one part of that column every agent writes on the same scale; the
// numeric value is unit-chaos across agents (see severity-tiers.js). Small,
// so it breaks ties rather than driving order.
const LABEL_BONUS = { High: 40, Medium: 20, Low: 0 };

/**
 * @param rec  a recommendations row
 * @param ctx  { pageMetrics: Map<pageUrl, {impressions, clicks, ctr, avgPosition}>,
 *               learnedMap: Map<generatorId, learned>,
 *               groupSizes: Map<groupKey, number>,
 *               groupKeyFor: (rec) => string }
 * @returns { score, tier, tierLabel, factors: string[] }
 */
export function scoreRecommendation(rec, ctx = {}) {
  const { pageMetrics, learnedMap, groupSizes, groupKeyFor, declines } = ctx;
  const tier = severityTierFor(rec.recommendation_type);
  const factors = [`tier ${tier} (${severityTierLabel(rec.recommendation_type)})`];
  let score = tierBase(tier);

  const page = rec.params?.page || rec.page || null;
  const demand = demandScore(page ? pageMetrics?.get(page) : null);
  score += demand.score;
  factors.push(...demand.factors);

  const groupSize = groupKeyFor && groupSizes ? (groupSizes.get(groupKeyFor(rec)) || 1) : 1;
  const breadth = breadthScore(rec, groupSize);
  score += breadth.score;
  factors.push(...breadth.factors);

  const confidence = confidenceScore(rec, learnedMap?.get(rec.recommendation_type));
  score += confidence.score;
  factors.push(...confidence.factors);

  const label = rec.expected_impact?.label;
  if (LABEL_BONUS[label]) {
    score += LABEL_BONUS[label];
    factors.push(`impact label ${label} (+${LABEL_BONUS[label]})`);
  }

  // TRAJECTORY. demandScore above reads a LEVEL, so a page that fell from
  // 2,000 impressions to 400 scored below a flat page at 1,000 — the ranker
  // deprioritised precisely the pages that were bleeding. This is the
  // counterweight: a page losing ground is worth fixing in proportion to what
  // it is losing. See decline-detection.js for how the signals are measured
  // (and why a site-wide fall never marks every page).
  const decline = page ? declines?.get(page) : null;
  if (decline) {
    const urgency = Math.min(DECLINE_CAP, decline.declineScore);
    score += urgency;
    factors.push(`DECLINING: ${decline.reasons.join('; ')} (+${urgency})`);
  }

  // An expansion item with NO measured demand is speculative in a way the
  // tier alone doesn't capture — tier 3 exists for "real demand exists for
  // this page". Demoted toward the content tier rather than out of the run,
  // since thin GSC coverage means absent data often means unmeasured, not
  // worthless.
  //
  // Never applied to a DECLINING page. A page whose traffic has collapsed
  // reads as "no measured demand" for exactly the reason that makes it
  // urgent, and penalising it here would bury the worst cases — the further a
  // page fell, the more certainly it was ignored.
  if (tier === SEVERITY_TIER.EXPANSION && demand.score === 0 && !decline) {
    score -= STEP / 2;
    factors.push('no measured search demand for this page (-500)');
  }

  return { score: Math.round(score), tier, tierLabel: severityTierLabel(rec.recommendation_type), factors, declining: Boolean(decline) };
}

// Builds the page-keyed metric map scoreRecommendation reads. Kept here (not
// in the scheduler) so the scorer owns the shape it consumes. Rows arrive
// per (query,page) from getQueryPageMetrics; a page's impressions are summed
// across its queries and its position impression-weighted, matching how
// growth-opportunities.js aggregates the same source.
export function buildPageMetrics(queryPageRows = []) {
  const byPage = new Map();
  for (const row of queryPageRows) {
    if (!row.page) continue;
    const acc = byPage.get(row.page) || { impressions: 0, clicks: 0, positionWeight: 0 };
    acc.impressions += row.impressions || 0;
    acc.clicks += row.clicks || 0;
    if (row.avgPosition != null) acc.positionWeight += row.avgPosition * (row.impressions || 0);
    byPage.set(row.page, acc);
  }
  const out = new Map();
  for (const [page, acc] of byPage) {
    out.set(page, {
      impressions: acc.impressions,
      clicks: acc.clicks,
      ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
      avgPosition: acc.impressions > 0 && acc.positionWeight > 0
        ? Number((acc.positionWeight / acc.impressions).toFixed(2))
        : null,
    });
  }
  return out;
}
