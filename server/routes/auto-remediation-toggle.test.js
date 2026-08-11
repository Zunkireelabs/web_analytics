import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import clientsRouter, { validateAutoRemediationRequest } from './clients.js';

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
