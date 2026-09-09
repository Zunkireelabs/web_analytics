import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isShippable, hourInTimezone, isShipCatchupOwed, SHIP_HOUR_LOCAL, SHIP_CATCHUP_END_HOUR_LOCAL, SHIP_LOCK_JOB_NAME, GITHUB_CREDENTIAL_LOCK_JOB_NAME } from './ship-window.js';
import { rateLimitKey } from '../github/client.js';
import { jobKeyFor } from './job-lock.js';

const withRepo = { id: 1, repo_owner: 'acme', repo_name: 'site-a', timezone: 'Asia/Kolkata', auto_remediation_daily_limit: 30 };
const noRepo = { id: 2, repo_owner: null, repo_name: null, timezone: 'Asia/Kolkata' };

// A fixed instant, so these assertions don't drift with the wall clock.
// 2026-08-12T00:00:00Z is 05:30 in Asia/Kolkata (UTC+5:30) — before the 07:00
// ship hour — and 14:00 in Pacific/Kiritimati (UTC+14) — after it. One instant,
// two opposite answers, which is the whole point of doing this per site.
const MORNING_IST = new Date('2026-08-12T00:00:00Z');
const WITHIN_CATCHUP_WINDOW_IST = new Date('2026-08-12T03:30:00Z'); // 09:00 IST — inside [7, 11)
const AFTERNOON_IST = new Date('2026-08-12T09:00:00Z'); // 14:30 IST — window long closed

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
    assert.equal(hourInTimezone('Asia/Kolkata', MORNING_IST), 5);
    assert.equal(hourInTimezone('Pacific/Kiritimati', MORNING_IST), 14);
    assert.equal(hourInTimezone('UTC', MORNING_IST), 0);
  });
});

describe('isShipCatchupOwed', () => {
  test('owes nothing before the site\'s own ship hour', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: MORNING_IST }), false);
  });

  test('owes a run once the ship hour has passed and nothing shipped', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: WITHIN_CATCHUP_WINDOW_IST }), true);
  });

  // 2026-08-30 fix: a run that shipped SOMETHING but stopped short of the
  // daily budget (the circuit breaker tripping mid-run, most commonly) used
  // to be indistinguishable from a fully-used day — the remaining budgeted
  // items just sat there unattempted until tomorrow. Budget remaining, not
  // "shipped nothing", is the real question.
  test('still owes a run when the site shipped something today but has budget left', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 4, now: WITHIN_CATCHUP_WINDOW_IST }), true);
  });

  test('owes nothing once the site\'s daily budget is fully used', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 30, now: WITHIN_CATCHUP_WINDOW_IST }), false);
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 35, now: WITHIN_CATCHUP_WINDOW_IST }), false, 'over budget (limit lowered mid-day) must not re-open the window either');
  });

  test('defaults an unset daily limit to 60, matching auto-remediation\'s own default', () => {
    const noLimit = { ...withRepo, auto_remediation_daily_limit: undefined };
    assert.equal(isShipCatchupOwed({ site: noLimit, alreadyShippedToday: 45, now: WITHIN_CATCHUP_WINDOW_IST }), true);
    assert.equal(isShipCatchupOwed({ site: noLimit, alreadyShippedToday: 60, now: WITHIN_CATCHUP_WINDOW_IST }), false);
  });

  test('never owes a run to a site with no repository', () => {
    assert.equal(isShipCatchupOwed({ site: noRepo, alreadyShippedToday: 0, now: WITHIN_CATCHUP_WINDOW_IST }), false);
  });

  // The whole reason this bound exists: a stray process started well past the
  // morning window (e.g. a local dev server run at 7 PM with real prod creds)
  // must not still find shipping "owed" — see PR #55 on zunkireelabs-web.
  test('owes nothing once the catch-up window has closed, even with nothing shipped', () => {
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: AFTERNOON_IST }), false);
  });

  test('defaults the catch-up window to closing at 11:00, four hours after the ship hour', () => {
    assert.equal(SHIP_CATCHUP_END_HOUR_LOCAL, 11);
  });

  // The per-site timezone is load-bearing, not decoration: at one instant a
  // Kiritimati tenant is owed a catch-up (09:00 local, inside its window)
  // while an Indian tenant is not (00:30 local, before its ship hour).
  test('decides per tenant timezone at a single instant', () => {
    const kiritimati = { ...withRepo, timezone: 'Pacific/Kiritimati' };
    const instant = new Date('2026-08-11T19:00:00Z');
    assert.equal(isShipCatchupOwed({ site: kiritimati, alreadyShippedToday: 0, now: instant }), true);
    assert.equal(isShipCatchupOwed({ site: withRepo, alreadyShippedToday: 0, now: instant }), false);
  });

  test('falls back to the supplied timezone when a site has none', () => {
    const noTz = { ...withRepo, timezone: null };
    const instant = new Date('2026-08-11T19:00:00Z'); // 09:00 in Pacific/Kiritimati, inside its window
    assert.equal(isShipCatchupOwed({ site: noTz, alreadyShippedToday: 0, fallbackTimezone: 'UTC', now: instant }), false);
    assert.equal(isShipCatchupOwed({ site: noTz, alreadyShippedToday: 0, fallbackTimezone: 'Pacific/Kiritimati', now: instant }), true);
  });

  // Shipping is chained onto the 07:00 detection run (cron.js), so the guard's
  // hour has to match CRON_SCHEDULE's — a guard that still believed in 13:00
  // would call the day's work "not owed yet" for six hours after it was.
  test('defaults the ship hour to 07:00, matching the daily run', () => {
    assert.equal(SHIP_HOUR_LOCAL, 7);
  });
});

// The scheduled shipping run and its catch-up guard must contend for the SAME
// per-site key. If they ever diverge, the guard can open a second batch branch
// and a second PR for a client-day that is supposed to be one commit.
describe('shipping lock identity', () => {
  test('is scoped to a single site, so one tenant cannot stall another', () => {
    assert.equal(jobKeyFor(SHIP_LOCK_JOB_NAME, 1), 'auto-remediation-ship:1');
    assert.notEqual(
      jobKeyFor(SHIP_LOCK_JOB_NAME, 1), jobKeyFor(SHIP_LOCK_JOB_NAME, 2),
      'two tenants must never share one shipping lock',
    );
  });

  test('is not the old platform-wide key', () => {
    assert.notEqual(jobKeyFor(SHIP_LOCK_JOB_NAME, 1), 'auto-remediation-ship:all-sites');
  });
});

// Two live tenants (sites 1 and 8862) share one GitHub App installation as
// of 2026-09-09. The per-site lock above correctly lets them ship in
// different processes at the same moment — but each process's in-memory
// rate-limit tracking (github/client.js's lastRateLimitByCredential) is
// process-local, so without a SEPARATE lock keyed by the credential itself,
// two processes could spend the same shared budget without either seeing
// the other's spending. This is what closes that gap.
describe('GitHub credential shipping lock', () => {
  test('two sites on the same GitHub App installation resolve to the same credential key', () => {
    const siteA = { id: 1, github_app_installation_id: 153416356 };
    const siteB = { id: 8862, github_app_installation_id: 153416356 };
    assert.equal(rateLimitKey(siteA), rateLimitKey(siteB));
    assert.equal(
      jobKeyFor(GITHUB_CREDENTIAL_LOCK_JOB_NAME, rateLimitKey(siteA)),
      jobKeyFor(GITHUB_CREDENTIAL_LOCK_JOB_NAME, rateLimitKey(siteB)),
      'sharing one credential must mean sharing one credential-lock key, so the two sites serialize',
    );
  });

  test('two sites on distinct credentials never share a credential-lock key', () => {
    const siteA = { id: 1, github_app_installation_id: 153416356 };
    const siteC = { id: 999, github_app_installation_id: 999999999 };
    assert.notEqual(
      jobKeyFor(GITHUB_CREDENTIAL_LOCK_JOB_NAME, rateLimitKey(siteA)),
      jobKeyFor(GITHUB_CREDENTIAL_LOCK_JOB_NAME, rateLimitKey(siteC)),
    );
  });

  test('is a distinct lock namespace from the per-site lock, so acquiring one never satisfies the other', () => {
    const site = { id: 1, github_app_installation_id: 153416356 };
    assert.notEqual(
      jobKeyFor(GITHUB_CREDENTIAL_LOCK_JOB_NAME, rateLimitKey(site)),
      jobKeyFor(SHIP_LOCK_JOB_NAME, site.id),
    );
  });

  test('a PAT-based site is keyed by its env var name, not by site id', () => {
    const siteA = { id: 1, github_pat_env_var: 'GITHUB_PAT' };
    const siteB = { id: 2, github_pat_env_var: 'GITHUB_PAT' };
    assert.equal(rateLimitKey(siteA), rateLimitKey(siteB));
  });
});
