import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Same `mock.module` approach as agent-memory.test.js / store/recommendations.test.js
// (Node's --experimental-test-module-mocks, wired into this repo's `npm test`),
// but mocking whole collaborator modules rather than db.js: what's under test
// here is auto-remediation's own control flow — budget arithmetic, the
// consecutive-failure breaker, and the fact that the chain stops at an open PR
// — not the SQL underneath it. Specifiers are resolved relative to this file
// rather than hardcoded absolute paths so the suite isn't tied to one checkout
// location.
const resolve = (p) => new URL(p, import.meta.url).href;

let recommendations;
let draftedFindingIds;
let site;
let spentToday;
let recentDraftTypes; // action_types with a draft inside the pacing window
const calls = { generated: [], approved: [], prsOpened: [] };
let failOn; // (recommendationType) => boolean — simulates a step throwing
let refuseOn; // (recommendationType) => boolean — simulates a generator's principled 4xx refusal
let approveOpensPr; // whether approveAndPublishDraft already opened the PR (the normal production path)

function reset() {
  site = { id: 1, timezone: 'Asia/Kolkata', auto_remediation_enabled: true, auto_remediation_daily_limit: 30 };
  recommendations = [];
  draftedFindingIds = new Set();
  spentToday = 0;
  recentDraftTypes = new Set();
  calls.generated = [];
  calls.approved = [];
  calls.prsOpened = [];
  failOn = () => false;
  refuseOn = () => false;
  approveOpensPr = false;
}
reset();

function rec(id, { riskTier = 'safe', type = 'meta-title' } = {}) {
  return { id, risk_tier: riskTier, recommendation_type: type, params: { page: `/p${id}` }, finding_ids: [`f${id}`] };
}

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: { listOpenRecommendations: async () => recommendations },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: {
    getDraftedFindingIds: async () => draftedFindingIds,
    countDraftsBySourceToday: async () => spentToday,
    hasRecentDraftOfType: async (siteId, actionType, days) => days > 0 && recentDraftTypes.has(actionType),
    submitDraftForApproval: async (siteId, draftId) => ({ id: draftId }),
    updateDraft: async () => null,
  },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: {
    generateDraft: async (siteId, { generatorId, findingId }) => {
      // The shape real generators use to decline an item honestly — e.g. schema.js's
      // "had no real data on the page" and expand-content.js's ungrounded-citations
      // refusal, both { status: 400, userFacing: true }.
      if (refuseOn(generatorId)) {
        throw Object.assign(new Error(`refusing to draft ${generatorId} — no real data`), { status: 400, userFacing: true });
      }
      if (failOn(generatorId)) throw new Error(`simulated generate failure for ${generatorId}`);
      calls.generated.push(findingId);
      return { id: `d-${findingId}`, status: 'draft', content: {} };
    },
    approveAndPublishDraft: async (siteId, draftId) => {
      calls.approved.push(draftId);
      // approveAndPublishDraft ends in markDraftPrOpened whenever the resolved
      // implementer exposes mergeToStage — which every real one does — so in
      // production it usually returns with the PR ALREADY open. `approveOpensPr`
      // switches between that and the rarer stopped-at-branch_pushed shape.
      return approveOpensPr
        ? { id: draftId, branch_name: `auto/${draftId}`, pr_number: 47 }
        : { id: draftId, branch_name: `auto/${draftId}` };
    },
    openDraftPr: async (siteId, draftId) => {
      calls.prsOpened.push(draftId);
      return { id: draftId, pr_number: 1 };
    },
    autoSelectMetaTitle: () => null,
  },
});

const { autoRemediateSafeRecommendations } = await import('./auto-remediation.js');

describe('auto-remediation — opt-in gate', () => {
  beforeEach(reset);

  test('a site without the flag does nothing at all', async () => {
    site.auto_remediation_enabled = false;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'disabled');
    assert.equal(calls.generated.length, 0, 'must not touch a site that never opted in');
  });
});

describe('auto-remediation — chain shape', () => {
  beforeEach(reset);

  test('ships each candidate all the way to an OPEN PR, and stops there', async () => {
    recommendations = [rec(1), rec(2)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(calls.prsOpened, ['d-f1', 'd-f2'], 'every shipped draft must reach an open PR');
    // The absence of a merge step is the whole point of "unattended to PR,
    // human merges" — there is deliberately no markDraftImplemented here, and
    // no merge mock is provided, so a future change that added one would fail
    // this suite loudly rather than quietly start merging to a customer repo.
  });

  test('only safe-tier recommendations are eligible — design-blocked items are demoted to manual upstream', async () => {
    recommendations = [rec(1, { riskTier: 'manual' }), rec(2, { riskTier: 'safe' })];
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f2']);
  });

  test('a recommendation whose finding already has a draft is skipped', async () => {
    recommendations = [rec(1), rec(2)];
    draftedFindingIds = new Set(['f1']);
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f2']);
  });
});

describe('auto-remediation — daily budget', () => {
  beforeEach(reset);

  test('takes only what is left of today\'s budget and reports the rest as deferred', async () => {
    site.auto_remediation_daily_limit = 3;
    spentToday = 1;
    recommendations = [rec(1), rec(2), rec(3), rec(4), rec(5)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 2, 'limit 3 minus 1 already spent leaves room for 2');
    assert.equal(result.skipped, 3);
    assert.equal(result.spentToday, 1);
    assert.equal(result.dailyLimit, 3);
  });

  test('an exhausted budget attempts nothing and says so', async () => {
    site.auto_remediation_daily_limit = 5;
    spentToday = 5;
    recommendations = [rec(1), rec(2)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'budget-exhausted');
    assert.equal(result.attempted, 0);
    assert.equal(result.skipped, 2);
    assert.equal(calls.generated.length, 0);
  });

  test('a limit lowered below what was already spent is treated as no budget, never a negative slice', async () => {
    site.auto_remediation_daily_limit = 2;
    spentToday = 10;
    recommendations = [rec(1), rec(2)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'budget-exhausted');
    assert.equal(calls.generated.length, 0, 'a negative remaining must never fall through to slice(0, -8)');
  });

  test('a limit of 0 disables shipping without disabling the feature flag', async () => {
    site.auto_remediation_daily_limit = 0;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'budget-exhausted');
    assert.equal(calls.generated.length, 0);
  });
});

describe('auto-remediation — circuit breaker', () => {
  beforeEach(reset);

  test('three consecutive failures stop the run early, leaving the rest untouched and open', async () => {
    recommendations = [
      rec(1, { type: 'bad' }), rec(2, { type: 'bad' }), rec(3, { type: 'bad' }),
      rec(4), rec(5), rec(6),
    ];
    failOn = (type) => type === 'bad';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 3);
    assert.equal(result.shipped, 0);
    assert.equal(result.stoppedReason, 'circuit-breaker');
    assert.equal(result.attempted, 3, 'must not keep trying past the breaker');
    assert.equal(calls.generated.length, 0, 'none of the three succeeded');
  });

  test('a success resets the streak, so scattered failures do not trip the breaker', async () => {
    recommendations = [
      rec(1, { type: 'bad' }), rec(2), rec(3, { type: 'bad' }),
      rec(4), rec(5, { type: 'bad' }), rec(6),
    ];
    failOn = (type) => type === 'bad';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'alternating failures are normal, not systemic');
    assert.equal(result.shipped, 3);
    assert.equal(result.failed, 3);
    assert.equal(result.attempted, 6, 'every candidate was still attempted');
  });
});


// Regression guard for a bug found on the first real end-to-end run, where
// draft 698 opened PR #47 on zunkireelabs-web and was recorded as a FAILURE.
//
// approveAndPublishDraft ends in markDraftPrOpened for every real implementer,
// so the PR is normally already open by the time this loop's own openDraftPr
// call is reached. That call requires status 'branch_pushed' and the draft is
// 'pr_opened', so it threw, and the catch counted a fully successful item as
// failed. Three consecutive successes then tripped the circuit breaker — with
// the real 30-item budget the loop would have halted after 3 shipped items
// every day while reporting them all as failures.
describe('when approveAndPublishDraft already opened the PR (the normal path)', () => {
  beforeEach(() => { reset(); approveOpensPr = true; });

  test('does not try to open the PR a second time', async () => {
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.prsOpened, [], 'the PR already exists — opening it again throws');
    assert.equal(result.shipped, 1);
    assert.equal(result.failed, 0);
  });

  test('three successes in a row do NOT trip the circuit breaker', async () => {
    recommendations = [rec(1), rec(2), rec(3), rec(4)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 4, 'every item ships');
    assert.equal(result.stoppedReason, null, 'the breaker must not fire on successes');
  });

  test('still opens the PR when approve stopped at a pushed branch', async () => {
    approveOpensPr = false;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.prsOpened, ['d-f1'], 'this path still needs the explicit open');
    assert.equal(result.shipped, 1);
  });
});


// A generator declining to fabricate is the no-fabrication policy WORKING, and
// says nothing about system health — so it must not feed the circuit breaker,
// which exists for faults where every later attempt is also doomed (revoked
// token, moved default branch, conflicted batch branch).
//
// This was live on site 1: its three permanently-unfixable recommendations sort
// to positions 1, 2 and 3 (two high-priority), so the next scheduled run would
// have refused three times, tripped the breaker, and halted with 0 shipped and
// 35 shippable candidates untouched — every day, silently, while every component
// behaved exactly as designed.
describe('principled refusals vs systemic faults', () => {
  beforeEach(() => { reset(); approveOpensPr = true; });

  test('three refusals in a row do NOT trip the breaker, and later work still ships', async () => {
    refuseOn = (type) => type === 'schema';
    recommendations = [
      rec(1, { type: 'schema' }), rec(2, { type: 'schema' }), rec(3, { type: 'schema' }),
      rec(4), rec(5),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'refusals must not halt the run');
    assert.equal(result.refused, 3);
    assert.equal(result.shipped, 2, 'the shippable items after them still ship');
    assert.equal(result.attempted, 5);
  });

  test('three REAL faults in a row still trip the breaker', async () => {
    failOn = (type) => type === 'schema';
    recommendations = [
      rec(1, { type: 'schema' }), rec(2, { type: 'schema' }), rec(3, { type: 'schema' }),
      rec(4), rec(5),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'circuit-breaker', 'a systemic fault must still stop the run');
    assert.equal(result.refused, 0);
    assert.equal(result.shipped, 0);
  });

  test('a refusal resets the consecutive-fault count, so faults must be genuinely consecutive', async () => {
    failOn = (type) => type === 'faq';
    refuseOn = (type) => type === 'schema';
    recommendations = [
      rec(1, { type: 'faq' }), rec(2, { type: 'faq' }),
      rec(3, { type: 'schema' }),   // refusal breaks the run of faults
      rec(4, { type: 'faq' }), rec(5),
    ];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, null);
    assert.equal(result.shipped, 1);
  });

  test('refusals are still counted in failed, so a run never overstates what landed', async () => {
    refuseOn = () => true;
    recommendations = [rec(1), rec(2)];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.failed, 2);
    assert.equal(result.refused, 2);
    assert.equal(result.shipped, 0);
  });
});

// Publishing cadence for net-new content (sites.blog_min_gap_days, migration
// 107). The daily budget can't express this on its own: 28 open blog-outline
// recommendations are 28 legitimate candidates as far as it is concerned.
describe('autoRemediateSafeRecommendations — blog pacing', () => {
  beforeEach(reset);

  test('ships at most one blog per run, however many are open', async () => {
    recommendations = [
      rec(1, { type: 'blog-outline' }),
      rec(2, { type: 'blog-outline' }),
      rec(3, { type: 'blog-outline' }),
    ];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f1'], 'takes the highest-priority blog and defers the rest');
  });

  test('ships no blog at all when one was published inside the gap window', async () => {
    recentDraftTypes.add('blog-outline');
    recommendations = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' })];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 0);
    assert.deepEqual(calls.generated, []);
  });

  test('pacing a blog never blocks ordinary fixes in the same run', async () => {
    recentDraftTypes.add('blog-outline');
    recommendations = [
      rec(1, { type: 'blog-outline' }),
      rec(2, { type: 'meta-title' }),
      rec(3, { type: 'faq' }),
    ];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 2);
    assert.deepEqual(calls.generated, ['f2', 'f3']);
  });

  test('the surviving blog competes for the same daily budget, with no separate allowance', async () => {
    site.auto_remediation_daily_limit = 2;
    recommendations = [
      rec(1, { type: 'blog-outline' }),
      rec(2, { type: 'meta-title' }),
      rec(3, { type: 'faq' }),
    ];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 2, 'the blog occupies one of the 2 slots — it does not get a third');
    assert.deepEqual(calls.generated, ['f1', 'f2']);
  });

  test('blog_min_gap_days = 0 disables the gap but still holds the one-per-run cap', async () => {
    site.blog_min_gap_days = 0;
    recentDraftTypes.add('blog-outline');
    recommendations = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' })];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f1']);
  });
});

// Regression: the live table has rows that are 'safe' AND blocked at the same
// time, which the old "risk_tier is enough" assumption said was impossible.
describe('autoRemediateSafeRecommendations — blocked recommendations', () => {
  beforeEach(reset);

  test('never attempts a safe-tier recommendation that carries a blocked_reason', async () => {
    recommendations = [
      { ...rec(1), blocked_reason: 'No url_file_map entry resolves this page to a file.' },
      rec(2),
    ];

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f2'], 'the blocked row would 422 and burn a circuit-breaker slot');
  });

  test('a run of blocked rows cannot trip the circuit breaker', async () => {
    recommendations = [1, 2, 3, 4].map((i) => ({ ...rec(i), blocked_reason: 'design not verified' }));
    recommendations.push(rec(5));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, null, 'blocked rows must be filtered out, not attempted and failed');
    assert.equal(result.shipped, 1);
  });

  // The full eligibility matrix, stated once and explicitly. Only one of the
  // four combinations may ship unattended, and the three that may not are
  // each excluded for a different reason — so asserting them together is what
  // stops a future change from fixing one and quietly regressing another.
  //
  // Migration 108 now forbids the safe+blocked row at the database level, but
  // this suite deliberately still constructs one: the invariant is asserted in
  // four independent places (coordinator, DB constraint, and both unattended
  // selectors) precisely because relying on a single layer is what produced
  // the 45 contradictory rows in the first place. This pins THIS layer.
  const MATRIX = [
    { name: 'safe + unblocked', riskTier: 'safe', blocked: null, eligible: true },
    { name: 'safe + blocked', riskTier: 'safe', blocked: 'design not verified', eligible: false },
    { name: 'manual + unblocked', riskTier: 'manual', blocked: null, eligible: false },
    { name: 'manual + blocked', riskTier: 'manual', blocked: 'design not verified', eligible: false },
  ];

  for (const c of MATRIX) {
    test(`${c.name} -> ${c.eligible ? 'executable' : 'not executable'}`, async () => {
      recommendations = [{ ...rec(1, { riskTier: c.riskTier }), blocked_reason: c.blocked }];

      const result = await autoRemediateSafeRecommendations(1);
      assert.equal(result.shipped, c.eligible ? 1 : 0);
      assert.deepEqual(calls.generated, c.eligible ? ['f1'] : []);
      assert.equal(result.stoppedReason, null, 'an ineligible row is skipped, never attempted-and-failed');
    });
  }
});
