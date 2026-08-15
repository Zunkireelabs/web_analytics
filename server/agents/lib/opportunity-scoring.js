// Shared striking-distance scoring math — extracted from agents/opportunity.js
// so the Analyst page's Growth Opportunities section (server/agents/lib/
// growth-opportunities.js) reuses the exact same formula rather than
// maintaining a second, silently-diverging one. opportunity.js still owns
// live page fetching, generator routing and the LLM narrative; only the pure
// numbers move here.

// Approximate industry-aggregate organic CTR by position (blended desktop/
// mobile, order-of-magnitude only). This is NOT measured for this site and
// is never presented as one — it's solely the baseline used to project
// estimated traffic gain, and callers must always pair it with an assumptions
// note so it can't be mistaken for an observed fact.
const CTR_BY_POSITION = { 1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.07, 6: 0.05, 7: 0.04, 8: 0.03, 9: 0.025, 10: 0.02 };
const CTR_TAIL = 0.015; // positions 11+
export const ctrAtPosition = (p) => CTR_BY_POSITION[Math.round(p)] ?? CTR_TAIL;

// Realistic improvement target used to project traffic gain (page-1-top, not
// an unrealistic #1).
export const TARGET_POSITION = 3;

export const TRAFFIC_GAIN_NOTE =
  `estimatedTrafficGain assumes the query reaches position ${TARGET_POSITION} and applies an ` +
  'approximate industry-average CTR-by-position curve — an estimate, not a guarantee, not measured for this site.';
export const DIFFICULTY_NOTE =
  'estimatedDifficulty (1-5) is an internal proxy from current position + relative impression volume only — ' +
  'not true keyword difficulty, since no backlink/competitor data source exists.';

// 0-1: how close to page 1 within [minPosition, maxPosition] — 1 at
// minPosition (best), 0 at maxPosition (worst).
export function positionFactor(avgPosition, minPosition, maxPosition) {
  return Math.min(1, Math.max(0, (maxPosition - avgPosition) / (maxPosition - minPosition)));
}

export function opportunityScore(impressions, avgPosition, minPosition, maxPosition) {
  return Math.round(impressions * positionFactor(avgPosition, minPosition, maxPosition));
}

export function estimatedTrafficGain(impressions, ctr, targetCtr = ctrAtPosition(TARGET_POSITION)) {
  return Math.max(0, Math.round(impressions * (targetCtr - ctr)));
}

// Difficulty proxy: harder = further from page 1 + more impression volume
// relative to the batch it's scored within (maxImpressions). Internal signal
// only — no backlink/competitor data exists, so this is explicitly a proxy,
// never true keyword difficulty.
export function estimatedDifficulty(avgPosition, impressions, maxImpressions, minPosition, maxPosition) {
  const positionComponent = (avgPosition - minPosition) / (maxPosition - minPosition);
  const volumeComponent = maxImpressions > 0 ? impressions / maxImpressions : 0;
  return Math.min(5, Math.max(1, Math.round((0.5 * positionComponent + 0.5 * volumeComponent) * 4) + 1));
}
