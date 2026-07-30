import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetricChange, healthChangeEntry } from './changes.js';

describe('computeMetricChange', () => {
  test('null when there is no previous run at all (only one valid run ever) — never fabricates a delta from a single data point', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 40 } };
    assert.equal(computeMetricChange(current, null), null);
    assert.equal(computeMetricChange(current, undefined), null);
  });

  test('null when the current run itself is not ok', () => {
    const current = { status: 'error', facts: null };
    const previous = { status: 'ok', facts: { aiVisibilityPct: 40 } };
    assert.equal(computeMetricChange(current, previous), null);
  });

  test('null when the previous run is not ok (e.g. insufficient-data)', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 40 } };
    const previous = { status: 'insufficient-data', facts: null };
    assert.equal(computeMetricChange(current, previous), null);
  });

  test('null when either run predates aiVisibilityPct existing', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 40 } };
    const previous = { status: 'ok', facts: {} }; // pre-multi-provider row, no aiVisibilityPct key
    assert.equal(computeMetricChange(current, previous), null);
  });

  test('real visibilityDelta when both runs are ok with real percentages', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 30 } };
    const previous = { status: 'ok', facts: { aiVisibilityPct: 50 } };
    const result = computeMetricChange(current, previous);
    assert.equal(result.visibilityDelta, -20);
  });

  test('gapDelta is null when either run predates competitorCitationGapPct (Phase 3), even though visibilityDelta is still computed', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 30, competitorCitationGapPct: 10 } };
    const previous = { status: 'ok', facts: { aiVisibilityPct: 50 } }; // no competitorCitationGapPct
    const result = computeMetricChange(current, previous);
    assert.equal(result.visibilityDelta, -20);
    assert.equal(result.gapDelta, null);
  });

  test('real gapDelta when both runs have a real competitorCitationGapPct', () => {
    const current = { status: 'ok', facts: { aiVisibilityPct: 30, competitorCitationGapPct: 25 } };
    const previous = { status: 'ok', facts: { aiVisibilityPct: 35, competitorCitationGapPct: 10 } };
    const result = computeMetricChange(current, previous);
    assert.equal(result.gapDelta, 15);
  });
});

describe('healthChangeEntry (existing, unaffected by this change)', () => {
  test('null when trendWeek is null or 0', () => {
    assert.equal(healthChangeEntry(null, '2026-01-01'), null);
    assert.equal(healthChangeEntry(0, '2026-01-01'), null);
  });

  test('real entry when trendWeek is non-zero', () => {
    const entry = healthChangeEntry(-5, '2026-01-01');
    assert.equal(entry.type, 'health');
    assert.equal(entry.positive, false);
  });
});
