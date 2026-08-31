import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import clientsRouter, {
  validateAutoRemediationRequest, shouldAutoEnableOnConnect, shouldAutoEnableOnDesignReviewApproval,
} from './clients.js';
import { designReviewFingerprint } from '../implementers/lib/design-drift.js';
import { DESIGN_PROFILE_VERSION } from '../design-agent/live-analysis/schema.js';

// The switch that decides whether a site's agents open pull requests against
// a real customer repository with nobody watching. Before this existed,
// sites.auto_remediation_enabled was readable in exactly one place and
// writable nowhere — which is the actual reason the unattended loop had never
// run for any site (see migration 101's own note).

// A minimal usable profile (isProfileUsable's floor: typography.body,
// typography.heading.item, layout.container-or-prose) — enough for
// designReviewFingerprint to hash something real, not a stand-in for
// coverage of the design-review mechanism itself (design-drift.test.js and
// design-review.test.js own that).
const SAMPLE_PROFILE = {
  version: DESIGN_PROFILE_VERSION,
  typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
  layout: { container: 'max-w-7xl mx-auto' },
  pages: [],
};

const withRepo = { repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web' };
const withoutRepo = { repo_owner: null, repo_name: null };

// A site with a repo AND a CURRENT, staff-approved design review — the state
// every "enabling should succeed" fixture below now needs, since the
// design-integrity gate folded into validateAutoRemediationRequest requires
// both. design_review_fingerprint is computed from the SAME profile the site
// carries, so designReviewState reads it as current, never stale.
function withReviewedDesign(overrides = {}) {
  const base = { ...withRepo, url_file_map: { siteRoot: { designProfile: SAMPLE_PROFILE } }, ...overrides };
  return { ...base, design_review_at: '2026-08-01T00:00:00Z', design_review_fingerprint: designReviewFingerprint(SAMPLE_PROFILE) };
}

describe('validateAutoRemediationRequest — enabling', () => {
  test('accepts enabling a site that has a repo connected AND a current, approved design review', () => {
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withReviewedDesign() }), null);
  });

  test('REFUSES enabling a site with no repo — it would have nowhere to open a PR', () => {
    // Live at the time of writing: 3 of 4 real client sites had no repo at
    // all. Without this the toggle would appear to work and then fail per
    // item every morning, burning the daily budget on a misconfiguration.
    // The repo check fires before the design-review check below, so an
    // unreviewed design never masks this specific, more fundamental error.
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withoutRepo });
    assert.match(err, /no GitHub repository connected/i);
  });

  test('refuses a half-configured repo (owner but no name)', () => {
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: { repo_owner: 'x', repo_name: null } });
    assert.match(err, /no GitHub repository connected/i);
  });

  // The design-integrity gate (design-integrity-gate proposal): a wrong-role
  // design profile shipped real classes in the wrong slots, verified only
  // against class EXISTENCE, with no human checkpoint anywhere in the chain.
  // A repo connection alone is no longer sufficient to enable the unattended
  // pipeline — the design must ALSO have been reviewed and signed off.
  test('REFUSES enabling a site with a repo but an UNREVIEWED design', () => {
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withRepo });
    assert.match(err, /design has not been reviewed/i);
  });

  test('REFUSES enabling a site whose design review is STALE — re-derived since it was approved', () => {
    const rescanned = { ...SAMPLE_PROFILE, typography: { ...SAMPLE_PROFILE.typography, body: 'text-lg leading-loose' } };
    const site = withReviewedDesign({ url_file_map: { siteRoot: { designProfile: rescanned } } }); // approved fingerprint is for SAMPLE_PROFILE, not this one
    const err = validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site });
    assert.match(err, /re-analyzed since it was last reviewed/i);
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
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 0, site: withReviewedDesign() }), null);
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
  // Realistic only when design was reviewed BEFORE this repo connection —
  // the design-integrity gate now folded into validateAutoRemediationRequest
  // requires both. The far more common real order (repo first, design
  // second) is covered by shouldAutoEnableOnDesignReviewApproval below.
  test('a brand-new site connecting its repo for the first time, with an already-reviewed design, is granted autonomy', () => {
    const existing = { id: 1, name: 'Any Client', repo_owner: null, repo_name: null };
    const site = withReviewedDesign({
      id: 1, name: 'Any Client', repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60,
    });
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), true);
  });

  // The behavior change this whole gate exists for: repo connection ALONE —
  // the only requirement before the design-integrity gate existed — is no
  // longer sufficient. autonomy stays off until a human has also reviewed
  // the design (see the design-review-approve mirror, shouldAutoEnableOnDesignReviewApproval).
  test('a brand-new site connecting its repo with an UNREVIEWED design is NOT granted autonomy', () => {
    const existing = { id: 1, name: 'Any Client', repo_owner: null, repo_name: null };
    const site = { id: 1, name: 'Any Client', repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), false);
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
      const site = withReviewedDesign({ id: 99, name, repo_owner: 'x', repo_name: 'x-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 });
      assert.equal(shouldAutoEnableOnConnect({ existing, site }), true, `must grant autonomy identically regardless of tenant name (${name})`);
    }
  });
});

// The design-review-approve mirror of shouldAutoEnableOnConnect: the far
// more common real order of events (repo connected first — which, with the
// design-integrity gate now in place, can no longer auto-grant on its own —
// design reviewed second). Without this, EVERY site would need a THIRD,
// separate manual click on the /auto-remediation switch after an otherwise-
// complete setup.
describe('shouldAutoEnableOnDesignReviewApproval', () => {
  test('a site\'s first-ever design review approval, with a repo already connected, is granted autonomy', () => {
    const existing = { id: 1, repo_owner: 'anyone', repo_name: 'anyone-web', design_review_at: null, auto_remediation_enabled: false };
    const site = withReviewedDesign({ id: 1, auto_remediation_enabled: false, auto_remediation_daily_limit: 60 });
    assert.equal(shouldAutoEnableOnDesignReviewApproval({ existing, site }), true);
  });

  test('a first design-review approval with NO repo connected yet is not granted — nowhere to open a PR', () => {
    const existing = { id: 2, repo_owner: null, repo_name: null, design_review_at: null, auto_remediation_enabled: false };
    const site = withReviewedDesign({ id: 2, repo_owner: null, repo_name: null, auto_remediation_enabled: false, auto_remediation_daily_limit: 60 });
    assert.equal(shouldAutoEnableOnDesignReviewApproval({ existing, site }), false);
  });

  // A RE-approval (re-reviewing after a stale rescan) must never silently
  // re-flip a switch a human may have deliberately turned off in between —
  // the identical concern shouldAutoEnableOnConnect's own "first connection
  // only" scoping addresses for repo connections.
  test('a RE-approval (design_review_at already set before this one) never auto-grants', () => {
    const existing = { id: 3, repo_owner: 'anyone', repo_name: 'anyone-web', design_review_at: '2026-07-01T00:00:00Z', auto_remediation_enabled: false };
    const site = withReviewedDesign({ id: 3, auto_remediation_enabled: false, auto_remediation_daily_limit: 60 });
    assert.equal(shouldAutoEnableOnDesignReviewApproval({ existing, site }), false);
  });

  test('already enabled is never re-written — idempotent', () => {
    const existing = { id: 4, repo_owner: 'anyone', repo_name: 'anyone-web', design_review_at: null, auto_remediation_enabled: true };
    const site = withReviewedDesign({ id: 4, auto_remediation_enabled: true, auto_remediation_daily_limit: 60 });
    assert.equal(shouldAutoEnableOnDesignReviewApproval({ existing, site }), false);
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
