import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import clientsRouter, { validateAutoRemediationRequest, shouldAutoEnableOnConnect } from './clients.js';

// The switch that decides whether a site's agents open pull requests against
// a real customer repository with nobody watching. Before this existed,
// sites.auto_remediation_enabled was readable in exactly one place and
// writable nowhere — which is the actual reason the unattended loop had never
// run for any site (see migration 101's own note).

const withRepo = { repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web' };
const withoutRepo = { repo_owner: null, repo_name: null };

describe('validateAutoRemediationRequest — enabling', () => {
  test('accepts enabling a site that has a repo connected', () => {
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withRepo }), null);
  });

  test('REFUSES enabling a site with no repo — it would have nowhere to open a PR', () => {
    // Live at the time of writing: 3 of 4 real client sites had no repo at
    // all. Without this the toggle would appear to work and then fail per
    // item every morning, burning the daily budget on a misconfiguration.
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withoutRepo });
    assert.match(err, /no GitHub repository connected/i);
  });

  test('refuses a half-configured repo (owner but no name)', () => {
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: { repo_owner: 'x', repo_name: null } });
    assert.match(err, /no GitHub repository connected/i);
  });
});

describe('validateAutoRemediationRequest — disabling', () => {
  test('ALWAYS allows disabling, even for a site with no repo', () => {
    // Refusing to turn autonomy off would be the wrong way round — the repo
    // check exists to stop a useless enable, not to trap a site in it.
    assert.equal(validateAutoRemediationRequest({ enabled: false, dailyLimit: 30, site: withoutRepo }), null);
  });
});

describe('validateAutoRemediationRequest — daily limit', () => {
  test('0 is valid — a deliberate "enabled but paused" state, matching migration 101\'s CHECK (>= 0)', () => {
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 0, site: withRepo }), null);
  });

  for (const bad of [-1, 1.5, '30', null, undefined, NaN]) {
    test(`rejects a daily limit of ${JSON.stringify(bad)}`, () => {
      const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: bad, site: withRepo });
      assert.match(err, /non-negative integer/i);
    });
  }
});

describe('validateAutoRemediationRequest — enabled flag', () => {
  for (const bad of ['true', 1, null, undefined]) {
    test(`rejects a non-boolean enabled of ${JSON.stringify(bad)}`, () => {
      const err = validateAutoRemediationRequest({ enabled: bad, dailyLimit: 30, site: withRepo });
      assert.match(err, /true or false/i);
    });
  }
});

// Full onboarding autonomy (no per-tenant admin click): connect-repo grants
// the same consent this file's /auto-remediation route otherwise requires an
// admin to set by hand, but ONLY on a genuinely first-time connection — never
// silently reversing a human's later decision to turn it off. Fixtures use
// generic ids/names throughout — this must behave identically for any tenant.
describe('shouldAutoEnableOnConnect', () => {
  test('a brand-new site connecting its repo for the first time is granted autonomy', () => {
    const existing = { id: 1, name: 'Any Client', repo_owner: null, repo_name: null };
    const site = { id: 1, name: 'Any Client', repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), true);
  });

  test('re-saving an already-connected repo\'s config never re-grants — respects whatever the current value already is', () => {
    const existing = { id: 2, name: 'Any Client', repo_owner: 'anyone', repo_name: 'anyone-web' };
    const site = { id: 2, name: 'Any Client', repo_owner: 'anyone', repo_name: 'renamed-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), false);
  });

  test('a half-configured previous repo (owner but no name) still counts as "already connected", not first-time', () => {
    const existing = { id: 3, repo_owner: 'anyone', repo_name: null };
    const site = { id: 3, repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), false);
  });

  test('already enabled (e.g. re-entrant call) is never re-written — idempotent', () => {
    const existing = { id: 4, repo_owner: null, repo_name: null };
    const site = { id: 4, repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: true, auto_remediation_daily_limit: 60 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), false);
  });

  test('defers to validateAutoRemediationRequest\'s own rules — an invalid daily limit refuses the auto-grant too', () => {
    const existing = { id: 5, repo_owner: null, repo_name: null };
    const site = { id: 5, repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: -1 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), false);
  });

  test('generic across tenants — no name/id-based special-casing', () => {
    for (const name of ['Zunkiree', 'Acme Corp', 'Some Other Client', 'client-42']) {
      const existing = { id: 99, name, repo_owner: null, repo_name: null };
      const site = { id: 99, name, repo_owner: 'x', repo_name: 'x-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
      assert.equal(shouldAutoEnableOnConnect({ existing, site }), true, `must grant autonomy identically regardless of tenant name (${name})`);
    }
  });
});

describe('route registration', () => {
  test('the toggle lives on the clients router, which is platform_admin-gated as a whole', () => {
    // clients.js applies requirePlatformRole('platform_admin') to the entire
    // router at the top of the file, so registering here IS the authorization
    // decision. If this route is ever moved to a router without that guard,
    // this assertion is the thing that should start failing.
    const paths = clientsRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(
      paths.includes('/internal/clients/:id/auto-remediation'),
      'the auto-remediation toggle is not registered on the platform_admin-gated clients router'
    );
  });
});
