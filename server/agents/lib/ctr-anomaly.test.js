import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flagBelowAverage, flagLowCtr, MIN_IMPRESSIONS_FOR_CTR, flagLowCtrSignificant, twoProportionZ } from './ctr-anomaly.js';

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

describe('flagLowCtrSignificant', () => {
  test('site 8862 shape: mobile 9/2191 vs desktop 14/1978 is z~1.3 and is NOT flagged (the old mean-of-2 flagged it)', () => {
    const rows = [
      { device: 'MOBILE', clicks: 9, impressions: 2191, ctr: 9 / 2191, avgPosition: 11.2 },
      { device: 'DESKTOP', clicks: 14, impressions: 1978, ctr: 14 / 1978, avgPosition: 11.5 },
    ];
    assert.ok(Math.abs(twoProportionZ(9, 2191, 14, 1978)) < 2);
    assert.equal(flagLowCtr(rows).length, 1, 'legacy behavior asserted a deficit');
    assert.deepEqual(flagLowCtrSignificant(rows), { flagged: [], confounded: [] });
  });

  test('a large, significant gap at comparable position is flagged with its z-score', () => {
    const rows = [
      { device: 'MOBILE', clicks: 40, impressions: 10000, avgPosition: 9 },
      { device: 'DESKTOP', clicks: 400, impressions: 10000, avgPosition: 8 },
    ];
    const { flagged, confounded } = flagLowCtrSignificant(rows);
    assert.deepEqual(flagged.map((r) => r.device), ['MOBILE']);
    assert.ok(flagged[0].ctrZ <= -2);
    assert.equal(confounded.length, 0);
  });

  test('a significant gap where the row ranks far worse is confounded by position -> abstain, reported separately', () => {
    const rows = [
      { device: 'DESKTOP', clicks: 40, impressions: 10000, avgPosition: 28.9 },
      { device: 'MOBILE', clicks: 400, impressions: 10000, avgPosition: 11.2 },
    ];
    const { flagged, confounded } = flagLowCtrSignificant(rows);
    assert.deepEqual(flagged, []);
    assert.deepEqual(confounded.map((r) => r.device), ['DESKTOP']);
  });

  test('baseline is impression-weighted: a tiny high-CTR row does not drag the baseline up', () => {
    const rows = [
      { device: 'A', clicks: 90, impressions: 3000, avgPosition: 8 },
      { device: 'B', clicks: 100, impressions: 3000, avgPosition: 8 },
      { device: 'C', clicks: 10, impressions: 100, avgPosition: 8 }, // 10% CTR on 100 impressions
    ];
    assert.deepEqual(flagLowCtrSignificant(rows).flagged.map((r) => r.device), []);
  });

  test('rows under the impression floor are ignored entirely', () => {
    const rows = [
      { device: 'A', clicks: 0, impressions: MIN_IMPRESSIONS_FOR_CTR - 1, avgPosition: 5 },
      { device: 'B', clicks: 50, impressions: 5000, avgPosition: 5 },
    ];
    assert.deepEqual(flagLowCtrSignificant(rows), { flagged: [], confounded: [] });
  });
});
