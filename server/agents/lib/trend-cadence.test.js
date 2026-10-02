import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendRadarDue } from './trend-cadence.js';

const at = (iso) => new Date(iso);

test('due when never run, or the last run did not succeed', () => {
  assert.equal(trendRadarDue(null, { now: at('2026-11-03T06:00:00Z') }), true);
  assert.equal(trendRadarDue({ status: 'error', created_at: '2026-11-03T06:00:00Z' }, { now: at('2026-11-04T06:00:00Z') }), true);
  assert.equal(trendRadarDue({ status: 'insufficient-data', created_at: '2026-11-03T06:00:00Z' }, { now: at('2026-11-04T06:00:00Z') }), true);
});

test('run on Oct 2 is not due again until November', () => {
  const last = { status: 'ok', created_at: '2026-10-02T09:00:00Z' };
  assert.equal(trendRadarDue(last, { now: at('2026-10-30T06:00:00Z') }), false);
  assert.equal(trendRadarDue(last, { now: at('2026-11-03T06:00:00Z') }), true);
});

test('a successful Nov 3 run blocks the Nov 4-9 retry days', () => {
  const last = { status: 'ok', created_at: '2026-11-03T06:00:05Z' };
  assert.equal(trendRadarDue(last, { now: at('2026-11-04T06:00:00Z') }), false);
  assert.equal(trendRadarDue(last, { now: at('2026-11-09T06:00:00Z') }), false);
});

test('month boundary is judged in the site timezone, not UTC', () => {
  // 2026-10-31 20:00 UTC is already Nov 1 in Kathmandu (UTC+5:45).
  const last = { status: 'ok', created_at: '2026-10-31T20:00:00Z' };
  assert.equal(trendRadarDue(last, { now: at('2026-11-03T06:00:00Z'), timeZone: 'Asia/Kathmandu' }), false);
  assert.equal(trendRadarDue(last, { now: at('2026-11-03T06:00:00Z'), timeZone: 'UTC' }), true);
});

test('nothing is due before the rollout month, even with no prior run', () => {
  assert.equal(trendRadarDue(null, { now: at('2026-10-03T06:00:00Z'), enabledFrom: '2026-11' }), false);
  assert.equal(trendRadarDue(null, { now: at('2026-10-09T06:00:00Z'), enabledFrom: '2026-11' }), false);
  assert.equal(trendRadarDue(null, { now: at('2026-11-03T06:00:00Z'), enabledFrom: '2026-11' }), true);
});
