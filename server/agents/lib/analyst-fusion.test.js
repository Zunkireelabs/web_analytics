import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { familiesForDecliningPage, generatorForDecliningPage, MIN_CORROBORATION_TO_ACT } from './analyst-fusion.js';

// Pure signal-grouping logic — no database. Exercises acceptance scenarios
// 1 (future decline, multi-signal) and 4 (weak evidence -> monitor) directly.

describe('familiesForDecliningPage', () => {
  test('a single decline-detection reason alone is ONE family, below the act threshold', () => {
    const decline = { reasons: ['CTR 5.0% -> 3.0% (40% decay)'], impressionsLost: 0, impressionsAtRisk: 100 };
    const { families } = familiesForDecliningPage(decline, []);
    assert.equal(families.size, 1);
    assert.ok(families.size < MIN_CORROBORATION_TO_ACT, 'one signal must not clear the evidence bar on its own');
  });

  test('a single anomaly with NO decline-detection reason is still just one family', () => {
    // This is the exact failure mode the request calls out: "do not create
    // recommendations simply because an anomaly exists".
    const decline = { reasons: [], impressionsLost: 0, impressionsAtRisk: 0 };
    const insights = [{ page: '/x', insight_type: 'anomaly', evidence: { direction: 'low', method: 'zscore', score: 4.1 } }];
    const { families, signals } = familiesForDecliningPage(decline, insights);
    assert.equal(families.size, 1);
    assert.equal(signals.length, 1);
  });

  test('position erosion + impressions decline + anomaly + forecast_risk fuse into four corroborating families', () => {
    const decline = {
      reasons: [
        'position 4.0 -> 6.2 (slipped 2.2 places)',
        'impressions 2000 -> 1200 (35% below where the site-wide trend puts it)',
      ],
      impressionsLost: 800, impressionsAtRisk: 1200,
    };
    const insights = [
      { page: '/p', insight_type: 'anomaly', evidence: { direction: 'low', method: 'iqr', score: 2.1 } },
      { page: '/p', insight_type: 'forecast_risk', evidence: { confidence: 0.72, pct_projected_change: -22 } },
    ];
    const { families } = familiesForDecliningPage(decline, insights);
    assert.equal(families.size, 4);
    assert.ok(families.has('position-erosion'));
    assert.ok(families.has('impressions-decline'));
    assert.ok(families.has('anomaly'));
    assert.ok(families.has('forecast_risk'));
    assert.ok(families.size >= MIN_CORROBORATION_TO_ACT, 'four corroborating signals must clear the evidence bar');
  });

  test('a POSITIVE anomaly (direction high) is never counted as decline evidence', () => {
    const decline = { reasons: ['position 4.0 -> 6.2 (slipped 2.2 places)'], impressionsLost: 0, impressionsAtRisk: 500 };
    const insights = [{ page: '/p', insight_type: 'anomaly', evidence: { direction: 'high', method: 'zscore', score: 3.5 } }];
    const { families } = familiesForDecliningPage(decline, insights);
    assert.equal(families.size, 1, 'a high-direction anomaly on a declining page is not corroborating decline evidence');
  });

  test('a rising trend_shift is excluded even though the page is otherwise declining', () => {
    const decline = { reasons: ['position 4.0 -> 6.2 (slipped 2.2 places)'], impressionsLost: 0, impressionsAtRisk: 500 };
    const insights = [{ page: '/p', insight_type: 'trend_shift', evidence: { pct_change: 12 } }];
    const { families } = familiesForDecliningPage(decline, insights);
    assert.equal(families.size, 1);
  });
});

describe('generatorForDecliningPage', () => {
  test('position erosion routes to qa-content (answer the query more directly)', () => {
    const { generatorId } = generatorForDecliningPage({ reasons: ['position 4.0 -> 6.2 (slipped 2.2 places)'] }, '/p');
    assert.equal(generatorId, 'qa-content');
  });
  test('CTR decay routes to meta-title (a presentation problem)', () => {
    const { generatorId } = generatorForDecliningPage({ reasons: ['CTR 5.0% -> 3.0% (40% decay)'] }, '/p');
    assert.equal(generatorId, 'meta-title');
  });
  test('impressions-only decline routes to expand-content (a coverage problem)', () => {
    const { generatorId } = generatorForDecliningPage({ reasons: ['impressions 2000 -> 1200 (35% below where the site-wide trend puts it)'] }, '/p');
    assert.equal(generatorId, 'expand-content');
  });
});
