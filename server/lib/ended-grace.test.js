import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { endedBeyondGrace, ENDED_GRACE_DAYS } from './ended-grace.js';

const now = new Date('2026-11-05T12:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 864e5).toISOString();

describe('endedBeyondGrace', () => {
  test('is 30 days', () => assert.equal(ENDED_GRACE_DAYS, 30));
  test('a trial that ended 3 or 29 days ago is still theirs', () => {
    assert.equal(endedBeyondGrace({ state: 'ended', endedAt: daysAgo(3) }, now), false);
    assert.equal(endedBeyondGrace({ state: 'ended', endedAt: daysAgo(29) }, now), false);
  });
  test('one that ended more than 30 days ago is treated as new', () => {
    assert.equal(endedBeyondGrace({ state: 'ended', endedAt: daysAgo(31) }, now), true);
    assert.equal(endedBeyondGrace({ state: 'ended', endedAt: daysAgo(400) }, now), true);
  });
  test('only an ended trial can go stale', () => {
    for (const state of ['client', 'demo', 'pending', 'rejected']) assert.equal(endedBeyondGrace({ state, endedAt: daysAgo(90) }, now), false);
  });
  test('no end date, or nothing at all, is never stale', () => {
    assert.equal(endedBeyondGrace({ state: 'ended', endedAt: null }, now), false);
    assert.equal(endedBeyondGrace(null, now), false);
  });
});
