// THE FORECAST SKILL GATE — a prediction only drives work once it has earned it.
//
// The Data Analyst's prediction scorecard (data-analyst-agent/app/api/routes/scorecard.py, Stage 2) scores every daily
// forecast against what really happened AND against the cheapest possible guess ("the same weekday two weeks earlier").
// Until this module, Node never read that: a forecast_risk insight became a recommendation (plain sync) or counted as a
// corroborating signal (fusion) on the strength of its own stated confidence, even when the forecast for that metric had
// never been shown to beat repeating history. "No predictions without evidence or honest confidence."
//
// One verdict per metric, applied in ONE place by both paths (analyst-seo-mapping.js's sync and analyst-fusion.js), so
// there is still a single selector, not a second one:
//
//   proven    enough scored points AND the model beats the baseline at least half the time -> the forecast counts as is
//   unproven  too little scored history (new clients, or the scorecard unreachable)          -> never decides alone:
//                                                                                              low priority, human review
//   worse     enough scored points AND the model loses to the baseline                       -> withheld: repeating history
//                                                                                              is better than this forecast
//
// Only forecast_risk insights are touched. Observed declines, anomalies and trend shifts are measurements, not predictions.

import { callDataAnalystAgent } from '../../lib/data-analyst-client.js';

export const MIN_SCORED_FOR_SKILL = 20;   // same bar the scorecard itself uses for enough_to_judge
export const MIN_BEATS_BASELINE_SHARE = 0.5;

export const SKILL = Object.freeze({ PROVEN: 'proven', UNPROVEN: 'unproven', WORSE: 'worse' });

// scorecard -> { [metric_key]: { verdict, scored, naiveCompared, beatsBaselineShare, reason } }
// Pools the three horizon buckets per metric: a metric's forecast is judged on all the points it was scored on, with the
// baseline compared on the SAME points (naive_compared), so the share is a like-for-like win rate.
export function assessForecastSkill(scorecard) {
  const byMetric = new Map();
  for (const row of scorecard?.forecasts_by_horizon || []) {
    const m = byMetric.get(row.metric_key) || { scored: 0, naiveCompared: 0, wins: 0 };
    m.scored += Number(row.scored) || 0;
    const compared = Number(row.naive_compared) || 0;
    m.naiveCompared += compared;
    if (row.model_beats_naive_share != null) m.wins += Number(row.model_beats_naive_share) * compared;
    byMetric.set(row.metric_key, m);
  }
  const out = {};
  for (const [metric, m] of byMetric) {
    const share = m.naiveCompared ? m.wins / m.naiveCompared : null;
    const enough = m.scored >= MIN_SCORED_FOR_SKILL && m.naiveCompared >= MIN_SCORED_FOR_SKILL;
    let verdict; let reason;
    if (!enough) {
      verdict = SKILL.UNPROVEN;
      reason = `only ${m.scored} scored forecast point(s) so far (needs ${MIN_SCORED_FOR_SKILL}): accuracy is not yet measured`;
    } else if (share >= MIN_BEATS_BASELINE_SHARE) {
      verdict = SKILL.PROVEN;
      reason = `beats the same-weekday baseline on ${Math.round(share * 100)}% of ${m.naiveCompared} scored points`;
    } else {
      verdict = SKILL.WORSE;
      reason = `loses to the same-weekday baseline: beats it on only ${Math.round(share * 100)}% of ${m.naiveCompared} scored points`;
    }
    out[metric] = { verdict, scored: m.scored, naiveCompared: m.naiveCompared, beatsBaselineShare: share == null ? null : Number(share.toFixed(3)), reason };
  }
  return out;
}

// The verdict for one metric. A metric the scorecard has no row for is UNPROVEN, never assumed proven.
export function skillForMetric(skillByMetric, metricKey) {
  return (skillByMetric && skillByMetric[metricKey]) || {
    verdict: SKILL.UNPROVEN, scored: 0, naiveCompared: 0, beatsBaselineShare: null,
    reason: 'no scored forecast exists for this metric yet: accuracy is not measured',
  };
}

// Reads this site's scorecard. Never throws: if the Analyst is unreachable the answer is an empty map, which makes every
// forecast UNPROVEN (cannot decide alone) rather than silently trusted or silently crashing the nightly run.
export async function loadForecastSkill(siteId, { call } = {}) {
  try {
    // Called directly, with the site id in the path, so the tenant-isolation guard (lib/tenant-isolation.db.test.js) can see this
    // read is scoped to one project. `call` is only a test seam.
    const scorecard = call
      ? await call(`/clients/${siteId}/prediction-scorecard`)
      : await callDataAnalystAgent(`/clients/${siteId}/prediction-scorecard`);
    return { available: true, byMetric: assessForecastSkill(scorecard) };
  } catch (err) {
    return { available: false, byMetric: {}, error: err.message };
  }
}

// Annotates forecast_risk insights with their metric's verdict (insight.forecastSkill / forecastSkillReason). Other insight
// types pass through untouched. Pure; returns new objects.
export function annotateForecastSkill(insights, skill) {
  return (insights || []).map((insight) => {
    if (insight.insight_type !== 'forecast_risk') return insight;
    const s = skillForMetric(skill?.byMetric, insight.metric_key);
    return { ...insight, forecastSkill: s.verdict, forecastSkillReason: s.reason };
  });
}

// Plain-sync form: annotates, then withholds forecasts that lose to the baseline. `withheld` is returned (not discarded) so
// the caller can count and log what was held back and why.
export function applyForecastSkillGate(insights, skill) {
  const annotated = annotateForecastSkill(insights, skill);
  const kept = [];
  const withheld = [];
  for (const insight of annotated) {
    if (insight.insight_type === 'forecast_risk' && insight.forecastSkill === SKILL.WORSE) withheld.push(insight);
    else kept.push(insight);
  }
  return { insights: kept, withheld };
}

// A forecast counts as evidence only when proven.
export function forecastCountsAsEvidence(insight) {
  return insight.insight_type !== 'forecast_risk' || insight.forecastSkill === SKILL.PROVEN;
}
