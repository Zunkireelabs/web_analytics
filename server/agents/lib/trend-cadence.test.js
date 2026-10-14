import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendRadarDue, TREND_INTERVAL_DAYS } from './trend-cadence.js';

const at = (iso) => new Date(iso);
const ok = (iso) => ({ status: 'ok', created_at: iso });

test('the interval is a fortnight', () => assert.equal(TREND_INTERVAL_DAYS, 14));

test('due when never run, or the last run did not succeed', () => {
  assert.equal(trendRadarDue(null, { now: at('2026-11-03T06:00:00Z') }), true);
  assert.equal(trendRadarDue({ status: 'error', created_at: '2026-11-03T06:00:00Z' }, { now: at('2026-11-04T06:00:00Z') }), true);
  assert.equal(trendRadarDue({ status: 'insufficient-data', created_at: '2026-11-03T06:00:00Z' }, { now: at('2026-11-04T06:00:00Z') }), true);
});

test('not due again for 13 days after a successful run, due on the 14th', () => {
  const last = ok('2026-11-03T06:30:05Z');
  assert.equal(trendRadarDue(last, { now: at('2026-11-04T06:30:00Z') }), false);
  assert.equal(trendRadarDue(last, { now: at('2026-11-16T06:30:00Z') }), false);
  assert.equal(trendRadarDue(last, { now: at('2026-11-17T06:30:00Z') }), true);
});

test('a run at 06:31 does not miss the same minute two weeks later — days, not 14x24 hours', () => {
  // Ran at 06:31:40; the cron fires at 06:30:00 fourteen days on, 23h58m
  // short of 14x24 hours. It must still be due.
  assert.equal(trendRadarDue(ok('2026-11-03T06:31:40Z'), { now: at('2026-11-17T06:30:00Z') }), true);
});

test('runs repeat every fortnight, not once a month', () => {
  let last = ok('2026-11-03T06:30:00Z');
  const runs = [];
  for (let d = 4; d <= 60; d++) {
    const now = at(new Date(Date.UTC(2026, 10, d, 6, 30)).toISOString());
    if (trendRadarDue(last, { now })) { runs.push(now.toISOString().slice(0, 10)); last = ok(now.toISOString()); }
  }
  assert.deepEqual(runs, ['2026-11-17', '2026-12-01', '2026-12-15', '2026-12-29']);
});

test('a failed run is retried the next morning, not a fortnight later', () => {
  assert.equal(trendRadarDue({ status: 'error', created_at: '2026-11-17T06:30:00Z' }, { now: at('2026-11-18T06:30:00Z') }), true);
});

test('the day boundary is judged in the site timezone, not UTC', () => {
  // 2026-11-02 20:00 UTC is already Nov 3 in Kathmandu (UTC+5:45). On Nov 16
  // midday, UTC says 14 days have passed (Nov 2 -> Nov 16) but Kathmandu says
  // 13 (Nov 3 -> Nov 16), so only the UTC reading is due.
  const last = ok('2026-11-02T20:00:00Z');
  assert.equal(trendRadarDue(last, { now: at('2026-11-16T10:00:00Z'), timeZone: 'UTC' }), true);
  assert.equal(trendRadarDue(last, { now: at('2026-11-16T10:00:00Z'), timeZone: 'Asia/Kathmandu' }), false);
});

test('nothing is due before the rollout month, even with no prior run', () => {
  assert.equal(trendRadarDue(null, { now: at('2026-10-03T06:00:00Z'), enabledFrom: '2026-11' }), false);
  assert.equal(trendRadarDue(null, { now: at('2026-11-03T06:00:00Z'), enabledFrom: '2026-11' }), true);
});

test('the interval is overridable per call', () => {
  assert.equal(trendRadarDue(ok('2026-11-03T06:00:00Z'), { now: at('2026-11-10T06:00:00Z'), intervalDays: 7 }), true);
});
