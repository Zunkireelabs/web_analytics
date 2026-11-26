import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessForecastSkill, skillForMetric, loadForecastSkill, annotateForecastSkill, applyForecastSkillGate,
  forecastCountsAsEvidence, SKILL, MIN_SCORED_FOR_SKILL,
} from './analyst-forecast-skill.js';

// Three horizon buckets for one metric, in the shape the Python scorecard returns them.
const buckets = (metric, { scored, share }) => ['1-3', '4-7', '8-14'].map((horizon_days, i) => ({
  metric_key: metric, dimension_type: 'page', horizon_days, scored: scored[i], naive_compared: scored[i], model_beats_naive_share: share,
}));

describe('assessForecastSkill', () => {
  test('enough scored points and beating the baseline at least half the time is PROVEN', () => {
    const r = assessForecastSkill({ forecasts_by_horizon: buckets('gsc_clicks', { scored: [10, 10, 10], share: 0.6 }) });
    assert.equal(r.gsc_clicks.verdict, SKILL.PROVEN);
    assert.equal(r.gsc_clicks.scored, 30);
    assert.equal(r.gsc_clicks.beatsBaselineShare, 0.6);
  });

  test('enough scored points but losing to the baseline is WORSE', () => {
    const r = assessForecastSkill({ forecasts_by_horizon: buckets('gsc_clicks', { scored: [10, 10, 10], share: 0.3 }) });
    assert.equal(r.gsc_clicks.verdict, SKILL.WORSE);
    assert.match(r.gsc_clicks.reason, /loses to the same-weekday baseline/);
  });

  test('too few scored points is UNPROVEN, however good the share looks', () => {
    const r = assessForecastSkill({ forecasts_by_horizon: buckets('gsc_clicks', { scored: [3, 4, 5], share: 1 }) });
    assert.equal(r.gsc_clicks.verdict, SKILL.UNPROVEN);
    assert.ok(12 < MIN_SCORED_FOR_SKILL);
  });

  test('the baseline must have been compared on enough of the same points, not just the model scored', () => {
    const rows = [{ metric_key: 'm', horizon_days: '1-3', scored: 40, naive_compared: 2, model_beats_naive_share: 1 }];
    assert.equal(assessForecastSkill({ forecasts_by_horizon: rows }).m.verdict, SKILL.UNPROVEN);
  });

  test('metrics are judged separately and the share is pooled like-for-like across horizons', () => {
    const rows = [
      { metric_key: 'a', scored: 20, naive_compared: 20, model_beats_naive_share: 1 },
      { metric_key: 'a', scored: 20, naive_compared: 20, model_beats_naive_share: 0 },
      ...buckets('b', { scored: [10, 10, 10], share: 0.2 }),
    ];
    const r = assessForecastSkill({ forecasts_by_horizon: rows });
    assert.equal(r.a.beatsBaselineShare, 0.5);
    assert.equal(r.a.verdict, SKILL.PROVEN);   // exactly half counts
    assert.equal(r.b.verdict, SKILL.WORSE);
  });

  test('an empty or missing scorecard yields no verdicts, and a metric without one is UNPROVEN, never assumed proven', () => {
    assert.deepEqual(assessForecastSkill(null), {});
    assert.deepEqual(assessForecastSkill({}), {});
    assert.equal(skillForMetric({}, 'gsc_clicks').verdict, SKILL.UNPROVEN);
  });
});

describe('loadForecastSkill', () => {
  test('reads this site\'s scorecard through the shared client', async () => {
    let path;
    const r = await loadForecastSkill(7, { call: async (p) => { path = p; return { forecasts_by_horizon: buckets('m', { scored: [10, 10, 10], share: 0.9 }) }; } });
    assert.equal(path, '/clients/7/prediction-scorecard');
    assert.equal(r.available, true);
    assert.equal(r.byMetric.m.verdict, SKILL.PROVEN);
  });

  test('an unreachable Analyst never throws: nothing is trusted, so every forecast is UNPROVEN', async () => {
    const r = await loadForecastSkill(7, { call: async () => { throw new Error('connection refused'); } });
    assert.equal(r.available, false);
    assert.deepEqual(r.byMetric, {});
    const [i] = annotateForecastSkill([{ insight_type: 'forecast_risk', metric_key: 'm' }], r);
    assert.equal(i.forecastSkill, SKILL.UNPROVEN);
  });
});

describe('applyForecastSkillGate', () => {
  const skill = { byMetric: {
    good: { verdict: SKILL.PROVEN, reason: 'r' }, bad: { verdict: SKILL.WORSE, reason: 'worse than baseline' }, thin: { verdict: SKILL.UNPROVEN, reason: 'too early' },
  } };
  const forecast = (metric_key) => ({ insight_type: 'forecast_risk', metric_key });
  const input = [forecast('good'), forecast('bad'), forecast('thin'), forecast('nodata'),
    { insight_type: 'anomaly', metric_key: 'bad' }, { insight_type: 'trend_shift', metric_key: 'bad' }];

  test('withholds only forecasts that lose to the baseline; observed findings are never touched', () => {
    const { insights, withheld } = applyForecastSkillGate(input, skill);
    assert.deepEqual(withheld.map((i) => i.metric_key), ['bad']);
    assert.equal(insights.length, 5);
    assert.equal(insights.filter((i) => i.insight_type !== 'forecast_risk').length, 2);
  });

  test('annotates each kept forecast with its verdict and the reason', () => {
    const { insights } = applyForecastSkillGate(input, skill);
    const byMetric = Object.fromEntries(insights.filter((i) => i.insight_type === 'forecast_risk').map((i) => [i.metric_key, i]));
    assert.equal(byMetric.good.forecastSkill, SKILL.PROVEN);
    assert.equal(byMetric.thin.forecastSkill, SKILL.UNPROVEN);
    assert.equal(byMetric.nodata.forecastSkill, SKILL.UNPROVEN);
    assert.equal(byMetric.thin.forecastSkillReason, 'too early');
  });

  test('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(input));
    applyForecastSkillGate(input, skill);
    assert.deepEqual(input, copy);
  });
});

describe('forecastCountsAsEvidence', () => {
  test('only a PROVEN forecast counts; non-forecast insights always do', () => {
    assert.equal(forecastCountsAsEvidence({ insight_type: 'forecast_risk', forecastSkill: SKILL.PROVEN }), true);
    for (const s of [SKILL.UNPROVEN, SKILL.WORSE, undefined]) assert.equal(forecastCountsAsEvidence({ insight_type: 'forecast_risk', forecastSkill: s }), false);
    assert.equal(forecastCountsAsEvidence({ insight_type: 'anomaly' }), true);
  });
});
