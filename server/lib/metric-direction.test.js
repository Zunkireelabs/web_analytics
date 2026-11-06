import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWorsening, anomalyIsWorsening, lowerIsBetter } from './metric-direction.js';
import { seoDraftEligibility } from '../agents/lib/analyst-seo-mapping.js';

// Search position: a HIGHER number is a WORSE ranking. 3 -> 2 improved, 3 -> 3 unchanged, 3 -> 8 declined, 8 -> 15 declined.
const pct = (prior, current) => ((current - prior) / prior) * 100;
const CASES = [[3, 2, false], [3, 3, false], [3, 8, true], [8, 15, true]];

describe('metric direction', () => {
  for (const [prior, current, declined] of CASES) {
    test(`position ${prior} -> ${current} is ${declined ? 'a decline' : 'not a decline'}`, () => {
      assert.equal(isWorsening('gsc_position', pct(prior, current)), declined);
      assert.equal(isWorsening('gsc_position', current - prior), declined);
    });
  }
  test('every other metric: falling is worse', () => {
    assert.equal(isWorsening('gsc_clicks', pct(100, 80)), true);
    assert.equal(isWorsening('gsc_clicks', pct(100, 120)), false);
    assert.equal(isWorsening('gsc_clicks', 0), false);
  });
  test('unknown change is never a decline', () => {
    assert.equal(isWorsening('gsc_position', undefined), false);
    assert.equal(isWorsening('gsc_position', NaN), false);
  });
  test('anomalies: a HIGH position is the bad one; a LOW click count is the bad one', () => {
    assert.equal(anomalyIsWorsening('gsc_position', 'high'), true);
    assert.equal(anomalyIsWorsening('gsc_position', 'low'), false);
    assert.equal(anomalyIsWorsening('gsc_clicks', 'low'), true);
  });
  test('only position is lower-is-better', () => {
    assert.ok(lowerIsBetter('gsc_position') && !lowerIsBetter('gsc_ctr'));
  });
});

describe('the app\'s fix eligibility uses the ranking direction', () => {
  const site = { id: 1, website_domain: 'x.example' };
  const insight = (metric, evidence, type = 'trend_shift') => ({ metric_key: metric, dimension_type: 'page', dimension_value: 'https://x.example/pricing', insight_type: type, period_start: '2026-11-01', evidence });
  for (const [prior, current, declined] of CASES) {
    test(`a page whose position went ${prior} -> ${current} ${declined ? 'gets' : 'does not get'} a fix`, () => {
      const action = seoDraftEligibility(site, insight('gsc_position', { pct_change: pct(prior, current) }));
      if (declined) { assert.ok(action); assert.equal(action.generatorId, 'qa-content'); } else assert.equal(action, null);
    });
  }
  test('a position anomaly is a decline only when the position is HIGH', () => {
    assert.ok(seoDraftEligibility(site, insight('gsc_position', { direction: 'high' }, 'anomaly')));
    assert.equal(seoDraftEligibility(site, insight('gsc_position', { direction: 'low' }, 'anomaly')), null);
  });
  test('clicks behave exactly as before', () => {
    assert.ok(seoDraftEligibility(site, insight('gsc_clicks', { pct_change: -30 })));
    assert.equal(seoDraftEligibility(site, insight('gsc_clicks', { pct_change: 30 })), null);
  });
});
