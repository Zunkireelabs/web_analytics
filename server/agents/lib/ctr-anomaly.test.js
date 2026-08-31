import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flagBelowAverage, flagLowCtr, MIN_IMPRESSIONS_FOR_CTR } from './ctr-anomaly.js';

describe('flagLowCtr — real-volume floor', () => {
  // The bug this floor exists for: a small tenant's device breakdown is only
  // ever 2-3 rows, so one of them sits below the mean by arithmetic alone.
  // With no volume qualification, 3 clicks out of 5 impressions vs 2 out of 5
  // became a "high priority" CTR finding presented as computed evidence.
  test('a low-impression row is never flagged, however far below the mean it sits', () => {
    const rows = [
      { device: 'DESKTOP', ctr: 0.1, impressions: 5000 },
      { device: 'MOBILE', ctr: 0.09, impressions: 4000 },
      { device: 'TABLET', ctr: 0.01, impressions: 3 }, // 3 impressions, 0 clicks-ish
    ];
    assert.deepEqual(flagLowCtr(rows).map((r) => r.device), []);
  });

  test('a genuinely low-CTR row WITH real volume is still flagged', () => {
    const rows = [
      { device: 'DESKTOP', ctr: 0.1, impressions: 5000 },
      { device: 'MOBILE', ctr: 0.1, impressions: 4000 },
      { device: 'TABLET', ctr: 0.02, impressions: 900 },
    ];
    assert.deepEqual(flagLowCtr(rows).map((r) => r.device), ['TABLET']);
  });

  test('low-volume rows are excluded from the MEAN too, not just from the output', () => {
    // The 4-impression row has a freak 100% CTR. If it counted toward the
    // average, both real rows would be dragged far "below average" and
    // wrongly flagged.
    const rows = [
      { country: 'United States', ctr: 0.05, impressions: 8000 },
      { country: 'Canada', ctr: 0.048, impressions: 6000 },
      { country: 'Nepal', ctr: 1, impressions: 4 },
    ];
    assert.deepEqual(flagLowCtr(rows).map((r) => r.country), []);
  });

  test('exactly at the floor counts as real volume; one impression under does not', () => {
    const atFloor = [
      { device: 'DESKTOP', ctr: 0.1, impressions: 5000 },
      { device: 'MOBILE', ctr: 0.02, impressions: MIN_IMPRESSIONS_FOR_CTR },
    ];
    assert.deepEqual(flagLowCtr(atFloor).map((r) => r.device), ['MOBILE']);

    const underFloor = [
      { device: 'DESKTOP', ctr: 0.1, impressions: 5000 },
      { device: 'MOBILE', ctr: 0.02, impressions: MIN_IMPRESSIONS_FOR_CTR - 1 },
    ];
    assert.deepEqual(flagLowCtr(underFloor).map((r) => r.device), []);
  });

  test('every row below the floor means no comparison at all, never a fabricated one', () => {
    const rows = [
      { device: 'DESKTOP', ctr: 0.2, impressions: 8 },
      { device: 'MOBILE', ctr: 0.05, impressions: 6 },
    ];
    assert.deepEqual(flagLowCtr(rows), []);
  });
});

describe('flagBelowAverage — generic behavior is unchanged', () => {
  // internal-linking.js relies on this: internalLinkCount rows have no volume
  // dimension of their own, so no floor must be applied unless asked for.
  test('no volume floor by default', () => {
    const rows = [
      { page: '/a', internalLinkCount: 20 },
      { page: '/b', internalLinkCount: 18 },
      { page: '/c', internalLinkCount: 1 },
    ];
    const flagged = flagBelowAverage(rows, 'internalLinkCount', { thresholdPct: 50 });
    assert.deepEqual(flagged.map((r) => r.page), ['/c']);
    assert.equal(typeof flagged[0].internalLinkCountDeviationPct, 'number');
  });

  test('worst-first ordering is preserved', () => {
    const rows = [
      { device: 'A', ctr: 0.2, impressions: 1000 },
      { device: 'B', ctr: 0.05, impressions: 1000 },
      { device: 'C', ctr: 0.01, impressions: 1000 },
    ];
    assert.deepEqual(flagLowCtr(rows).map((r) => r.device), ['C', 'B']);
  });
});
