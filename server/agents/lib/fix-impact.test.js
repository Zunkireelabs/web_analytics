import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { measurementWindows, computeDelta } from './fix-impact.js';

const before = { clicks: 100, impressions: 10_000, ctr: 0.01, avgPosition: 12.4, start: '2026-06-01', end: '2026-06-28' };

describe('measurementWindows', () => {
  const w = measurementWindows('2026-07-01T00:00:00Z', 28);

  test('the before window ends the day before the merge', () => {
    assert.equal(w.before.end, '2026-06-30');
    assert.equal(w.before.start, '2026-06-03');
  });

  test('the after window starts after a settling gap, not at the merge', () => {
    // The days either side of a deploy are the noisiest in the series, and a
    // change has to be re-crawled before it can show up at all — measuring from
    // the merge itself would measure the deploy, not the fix.
    assert.equal(w.after.start, '2026-07-04');
    assert.equal(w.after.end, '2026-07-31');
  });

  test('both windows cover the same number of days, so neither side is favoured', () => {
    const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    assert.equal(days(w.before.start, w.before.end), days(w.after.start, w.after.end));
  });

  test('the windows never overlap', () => {
    assert.ok(Date.parse(w.after.start) > Date.parse(w.before.end));
  });
});

describe('computeDelta', () => {
  test('reports raw and percentage movement for clicks and impressions', () => {
    const d = computeDelta(before, { ...before, clicks: 150, impressions: 12_000 });
    assert.equal(d.clicks, 50);
    assert.equal(d.clicksPct, 50);
    assert.equal(d.impressions, 2000);
    assert.equal(d.impressionsPct, 20);
  });

  // The classic SEO reporting bug: position 12 -> 8 is an IMPROVEMENT, because
  // lower is better. A naive (after - before) would report -4 and read as a
  // regression in any UI that colours positive green.
  test('position improvement is POSITIVE even though the number fell', () => {
    const d = computeDelta(before, { ...before, avgPosition: 8.4 });
    assert.equal(d.avgPosition, 4, 'moving from 12.4 to 8.4 is a 4-place gain');
  });

  test('position regression is negative', () => {
    const d = computeDelta(before, { ...before, avgPosition: 15.4 });
    assert.equal(d.avgPosition, -3);
  });

  test('a zero baseline yields null rather than a division by zero or Infinity', () => {
    const d = computeDelta({ ...before, clicks: 0 }, { ...before, clicks: 25 });
    assert.equal(d.clicks, 25);
    assert.equal(d.clicksPct, null, 'percentage change from zero is undefined, not infinite');
  });

  test('a missing position on either side yields null, never a computed guess', () => {
    assert.equal(computeDelta({ ...before, avgPosition: null }, before).avgPosition, null);
    assert.equal(computeDelta(before, { ...before, avgPosition: null }).avgPosition, null);
  });

  // Anything rendering this must not be able to present it as proof the fix
  // caused the change, so the caveat travels with the data rather than living
  // only in a comment.
  test('every delta carries its observed-not-attributed basis and caveat', () => {
    const d = computeDelta(before, before);
    assert.equal(d.basis, 'observed');
    assert.match(d.caveat, /correlation, not attribution/);
  });

  test('an unchanged page reports a real zero, distinct from insufficient-data', () => {
    const d = computeDelta(before, before);
    assert.equal(d.impressions, 0);
    assert.equal(d.impressionsPct, 0);
  });
});
