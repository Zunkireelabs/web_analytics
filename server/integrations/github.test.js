import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let expiry;      // Date | null | Error
const DAY = 86_400_000;
// One frozen instant for the whole suite, passed into check() as its clock.
// Both sides of the comparison have to come from the SAME instant: reading
// Date.now() once here to build the expiry and again inside check() to
// measure it left a microseconds-wide window where a millisecond tick
// rounded 5 days down to 4, failing about one run in four.
const NOW = Date.parse('2026-08-13T00:00:00Z');
const clock = { now: () => NOW };

function reset() {
  site = {
    id: 1, repo_owner: 'acme', repo_name: 'site-a',
    github_pat_env_var: 'TEST_PAT',
    action_center_config_checked_at: new Date().toISOString(),
    action_center_config_gap_count: 0,
  };
  expiry = null;
  process.env.TEST_PAT = 'github_pat_test';
}
reset();

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('../github/client.js'), {
  namedExports: {
    getDefaultBranchSha: async () => 'abc123',
    getTokenExpiry: async () => { if (expiry instanceof Error) throw expiry; return expiry; },
  },
});

const { check } = await import('./github.js');

// The failure this guards against is specific and already happened: site 1's
// PAT expired between 2026-08-11 and 2026-08-12, the Action Center silently
// stopped opening pull requests, and nothing noticed for two days — because
// every surface only asked "does the token work right now", which it did, right
// up until it didn't.
describe('github integration check — token expiry warning', () => {
  beforeEach(reset);

  test('warns, with a date, when the token expires inside the window', async () => {
    expiry = new Date(NOW + 5 * DAY);
    const r = await check(site, clock);

    assert.equal(r.ok, true, 'a soon-to-expire token still works — this is a warning, not an outage');
    assert.match(r.recoveryAction, /expires in 5 day\(s\)/);
    assert.match(r.recoveryAction, /silently stops opening pull requests/);
    assert.equal(r.detail.tokenExpiresInDays, 5);
  });

  test('stays quiet for most of a token\'s life', async () => {
    expiry = new Date(NOW + 200 * DAY);
    const r = await check(site, clock);

    assert.equal(r.ok, true);
    assert.equal(r.recoveryAction, null, 'no nagging outside the warning window');
    assert.equal(r.detail.tokenExpiresInDays, 200);
  });

  test('reports a non-expiring token as such rather than guessing a date', async () => {
    expiry = null; // classic PAT, or fine-grained with no expiry
    const r = await check(site);

    assert.equal(r.ok, true);
    assert.equal(r.detail.tokenExpiresAt, null);
    assert.equal(r.detail.tokenExpiresInDays, null);
  });

  // The warning is a nice-to-have layered on top of a real connectivity check.
  // If reading the expiry header fails, the check must still report the thing
  // it primarily exists to report.
  test('an expiry lookup failure never breaks the check itself', async () => {
    expiry = new Error('network blip');
    const r = await check(site);

    assert.equal(r.ok, true);
    assert.equal(r.authStatus, 'valid');
    assert.equal(r.detail.defaultBranchSha, 'abc123');
  });

  test('expiry advice outranks config-gap advice — an expired token fails every draft', async () => {
    expiry = new Date(NOW + 3 * DAY);
    site.action_center_config_gap_count = 400;

    const r = await check(site, clock);
    assert.match(r.recoveryAction, /expires in 3 day\(s\)/, 'the more total failure wins the one advice slot');
  });

  test('config-gap advice still shows when the token is nowhere near expiry', async () => {
    expiry = new Date(NOW + 200 * DAY);
    site.action_center_config_gap_count = 400;

    const r = await check(site, clock);
    assert.match(r.recoveryAction, /config gap/i);
  });
});
