import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isShippable, hourInTimezone, isShipCatchupOwed, SHIP_HOUR_LOCAL } from './ship-window.js';

const withRepo = { id: 1, repo_owner: 'acme', repo_name: 'site-a', timezone: 'Asia/Kolkata' };
const noRepo = { id: 2, repo_owner: null, repo_name: null, timezone: 'Asia/Kolkata' };

// A fixed instant, so these assertions don't drift with the wall clock.
// 2026-08-12T04:00:00Z is 09:30 in Asia/Kolkata (UTC+5:30) — before the 13:00
// ship hour — and 18:00 in Pacific/Kiritimati (UTC+14) — after it. One instant,
// two opposite answers, which is the whole point of doing this per site.
const MORNING_IST = new Date('2026-08-12T04:00:00Z');
const AFTERNOON_IST = new Date('2026-08-12T09:00:00Z'); // 14:30 IST

describe('isShippable', () => {
  test('requires a repository, not analytics — there is nowhere to push otherwise', () => {
    assert.equal(isShippable(withRepo), true);
    assert.equal(isShippable(noRepo), false);
    assert.equal(isShippable({ repo_owner: 'acme', repo_name: null }), false);
    assert.equal(isShippable(undefined), false);
  });
});

describe('hourInTimezone', () => {
  test('resolves the same instant to different local hours per tenant', () => {
    assert.equal(hourInTimezone('Asia/Kolkata', MORNING_IST), 9);
    assert.equal(hourInTimezone('Pacific/Kiritimati', MORNING_IST), 18);
    assert.equal(hourInTimezone('UTC', MORNING_IST), 4);
  });
});

describe('isShipCatchupOwed', () => {
  test('owes nothing before the site\'s own ship hour', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: MORNING_IST }), false);
  });

  test('owes a run once the ship hour has passed and nothing shipped', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: AFTERNOON_IST }), true);
  });

  test('owes nothing when the scheduled run already produced work today', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 4, now: AFTERNOON_IST }), false);
  });

  test('never owes a run to a site with no repository', () => {
    assert.equal(isShipCatchupOwed({ site: noRepo, alreadyShippedToday: 0, now: AFTERNOON_IST }), false);
  });

  // The per-site timezone is load-bearing, not decoration: at one instant a
  // Kiritimati tenant is owed a catch-up while an Indian tenant is not.
  test('decides per tenant timezone at a single instant', () => {
    const kiritimati = { ...withRepo, timezone: 'Pacific/Kiritimati' };
    assert.equal(isShipCatchupOwed({ site: kiritimati, alreadyShippedToday: 0, now: MORNING_IST }), true);
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: MORNING_IST }), false);
  });

  test('falls back to the supplied timezone when a site has none', () => {
    const noTz = { ...withRepo, timezone: null };
    assert.equal(isShipCatchupOwed({ site: noTz, alreadyShippedToday: 0, fallbackTimezone: 'UTC', now: MORNING_IST }), false);
    assert.equal(isShipCatchupOwed({ site: noTz, alreadyShippedToday: 0, fallbackTimezone: 'Pacific/Kiritimati', now: MORNING_IST }), true);
  });

  test('defaults the ship hour to 13:00', () => {
    assert.equal(SHIP_HOUR_LOCAL, 13);
  });
});
