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
//
// migration 132's human design-review sign-off used to ALSO be required here
// (the design-integrity-gate proposal's change 04) — removed after it
// produced a real zero-PR cron day: design_review_at is null for every
// pre-existing site (no backfill ever ran), so every one of them read as
// permanently 'unreviewed' and the entire unattended pipeline never
// attempted a single recommendation. The role-mismatch check that gate was
// protecting against (verifyProfileRoles) still runs — automatically, per
// draft, at ship time (design-drift.js's checkDesignIntegrityGate, see
// backend.test.js/frontend.test.js) — it is just no longer a whole-site
// precondition to enabling autonomy at all. `auto_remediation_enabled` is
// the sole authorization switch this function guards.

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

// A site with a repo and a design review on file — used to prove review
// state (present, absent, or stale) no longer changes the outcome.
function withReviewedDesign(overrides = {}) {
  const base = { ...withRepo, url_file_map: { siteRoot: { designProfile: SAMPLE_PROFILE } }, ...overrides };
  return { ...base, design_review_at: '2026-08-01T00:00:00Z', design_review_fingerprint: designReviewFingerprint(SAMPLE_PROFILE) };
}

describe('validateAutoRemediationRequest — enabling', () => {
  test('accepts enabling a site that has a repo connected and a current, approved design review', () => {
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withReviewedDesign() }), null);
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

  // The regression this file exists to guard: `design_review_at` is null for
  // every site connected before migration 132 (no backfill ever ran), so
  // "unreviewed blocks enabling" meant no pre-existing site could EVER be
  // enabled without someone finding and using a review screen that, per the
  // gate's own commit, had "no staff-facing entry point" at the time it
  // shipped. That is exactly what produced a real zero-PR cron day.
  test('a repo-connected site with a NEVER-reviewed design (design_review_at null) can still be enabled', () => {
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site: withRepo }), null);
  });

  test('a repo-connected site whose design review is STALE (re-derived since approval) can still be enabled', () => {
    const rescanned = { ...SAMPLE_PROFILE, typography: { ...SAMPLE_PROFILE.typography, body: 'text-lg leading-loose' } };
    const site = withReviewedDesign({ url_file_map: { siteRoot: { designProfile: rescanned } } }); // approved fingerprint is for SAMPLE_PROFILE, not this one
    assert.equal(validateAutoRemediationRequest({ enabled: true, dailyLimit: 30, site }), null);
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
  test('a brand-new site connecting its repo for the first time, with an already-reviewed design, is granted autonomy', () => {
    const existing = { id: 1, name: 'Any Client', repo_owner: null, repo_name: null };
    const site = withReviewedDesign({
      id: 1, name: 'Any Client', repo_owner: 'anyone', repo_name: 'anyone-web', auto_remediation_enabled: false, auto_remediation_daily_limit: 60,
    });
    assert.equal(shouldAutoEnableOnConnect({ existing, site }), true);
  });

  // Repo connection ALONE is sufficient again (as it was before migration
  // 132) — `auto_remediation_enabled` no longer depends on a human having
  // reviewed the design first.
  test('a brand-new site connecting its repo with an UNREVIEWED design is ALSO granted autonomy', () => {
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

// The design-review-approve mirror of shouldAutoEnableOnConnect — still
// exercised even though a review is no longer required, because the review
// screen itself is still optional-but-supported, and this must keep
// behaving correctly for a site that arrives via that path.
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
