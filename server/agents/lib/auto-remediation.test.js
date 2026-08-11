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
const calls = { generated: [], approved: [], prsOpened: [] };
let failOn; // (recommendationType) => boolean — simulates a step throwing

function reset() {
  site = { id: 1, timezone: 'Asia/Kolkata', auto_remediation_enabled: true, auto_remediation_daily_limit: 30 };
  recommendations = [];
  draftedFindingIds = new Set();
  spentToday = 0;
  calls.generated = [];
  calls.approved = [];
  calls.prsOpened = [];
  failOn = () => false;
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
      if (failOn(generatorId)) throw new Error(`simulated generate failure for ${generatorId}`);
      calls.generated.push(findingId);
      return { id: `d-${findingId}`, status: 'draft', content: {} };
    },
    approveAndPublishDraft: async (siteId, draftId) => {
      calls.approved.push(draftId);
      return { id: draftId, branch_name: `auto/${draftId}` };
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
