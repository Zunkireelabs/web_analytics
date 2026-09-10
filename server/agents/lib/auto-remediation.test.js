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

// The credential-failure retry's real 2s wait would be paid by every test
// that exercises it — set before the module under test is imported below, so
// its constant picks this up.
process.env.CREDENTIAL_RETRY_DELAY_MS = '0';

let recommendations;
let draftedFindingIds;
let pendingDraftFilePaths;
let site;
let spentToday;
let fileEditsSpentToday; // countShippedFileEditsToday's return — the file-edits-only slice of spentToday
let recentDraftTypes; // action_types with a draft inside the pacing window
const calls = { generated: [], approved: [], prsOpened: [], closed: [], findingOrigins: [], batchFinalizeCalls: [], abandoned: [] };
// When set, submitDraftForApproval refuses (as it really does for any status
// outside 'draft'/'edited') and getDraft reports this status — the shape a
// draft left stranded by an earlier failed apply() actually has.
let stuckDraftStatus;
// The branch a stranded draft claims its commit is on. Only a draft on THIS
// run's batch branch has a live commit — see lib/draft-ship-state.js.
let stuckDraftBranch;
let failedAttempts; // Map(finding_id -> prior failed attempts), for the convergence cap
let finalizeBatchFails; // simulates the batch's one shared push/PR (finalizeBatchPr) failing
let finalizeBatchRateLimited; // ...and whether that failure was a transient GitHub rate limit
let finalizeBatchError; // ...and the text it failed with, which decides transient vs permanent
let failOn; // (recommendationType) => boolean — simulates a step throwing
let refuseOn; // (recommendationType) => boolean — simulates a generator's principled 4xx refusal
let staleOn; // (recommendationType) => boolean — simulates a refusal that also proves the recommendation's premise is gone (schema.js's `stale: true`)
let rateLimitOn; // (recommendationType) => bool — simulates GitHub's rate limit striking mid-loop
let applyFailureMessageOn; // (recommendationType) => string | null — simulates approveAndPublishDraftUnattended stopping short with no branch_name and this apply_error message
let lastGeneratorId; // set by the generateDraft mock, read by the approveAndPublishDraftUnattended mock just below it — same single-item-at-a-time sequencing shipDraftForRecommendation itself relies on
// (attemptNumber) => Error | null — full control over what generateDraft
// throws, for the cases where the shape of the error is what's under test
// (an explicit `refusal` flag on a 5xx, an unflagged 5xx) rather than merely
// whether it threw. Returning null lets the attempt succeed.
let generateError;
let approveOpensPr; // whether approveAndPublishDraft already opened the PR (the normal production path)
let recordedOutcomes; // Phase 5: [{generatorId, outcome}] recorded via the mocked recordOutcome below
let learnedMap; // Phase 5: generatorId -> {demote, ...} fed to classifyRecommendation via the mocked getLearnedConfidenceMap
let onboardingPending; // two-stage onboarding: whether the whole-site analysis job is still in flight
let learnedRepairQueueItems; // rows store/shipping-queue.js's listByState(QUEUED) would return, filtered to source='learned-repair' by the code under test
let contentRepairQueueItems; // rows store/shipping-queue.js's listByState(PREPARED) would return, filtered to source='content-repair'/kind='file-edits'
let contentRepairPushOn; // (queueId) => boolean — simulates a specific content-repair item's pushDraftBranch call failing

function reset() {
  site = { id: 1, timezone: 'Asia/Kolkata', auto_remediation_enabled: true, auto_remediation_daily_limit: 30 };
  onboardingPending = false; // matches every existing test's assumption: analysis already done, repair may proceed
  recommendations = [];
  draftedFindingIds = new Set();
  pendingDraftFilePaths = new Set();
  spentToday = 0;
  fileEditsSpentToday = 0;
  recentDraftTypes = new Set();
  calls.generated = [];
  calls.approved = [];
  calls.prsOpened = [];
  calls.closed = [];
  calls.findingOrigins = [];
  calls.batchFinalizeCalls = [];
  calls.abandoned = [];
  calls.retryable = [];
  calls.branchPushRetries = [];
  stuckDraftStatus = null;
  stuckDraftBranch = null;
  failedAttempts = new Map();
  finalizeBatchFails = false;
  finalizeBatchRateLimited = false;
  finalizeBatchError = 'simulated batch push/PR failure';
  failOn = () => false;
  rateLimitOn = () => false;
  refuseOn = () => false;
  staleOn = () => false;
  applyFailureMessageOn = () => null;
  generateError = () => null;
  generateAttempts = 0;
  approveOpensPr = false;
  recordedOutcomes = [];
  learnedMap = new Map();
  learnedRepairQueueItems = [];
  contentRepairQueueItems = [];
  contentRepairPushOn = () => false;
  calls.queueShipped = [];
  calls.queueReleased = [];
  calls.fixOutcomes = [];
}
let generateAttempts;
reset();

function rec(id, { riskTier = 'safe', type = 'meta-title', detectingAgents = ['opportunity'], page = `/p${id}` } = {}) {
  return {
    id, risk_tier: riskTier, recommendation_type: type, params: { page: `/p${id}` }, finding_ids: [`f${id}`],
    detecting_agents: detectingAgents, page,
  };
}

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    listOpenRecommendations: async () => recommendations,
    closeRecommendation: async (id) => { calls.closed.push(id); },
  },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: {
    getDraftedFindingIds: async () => draftedFindingIds,
    getPendingDraftFilePaths: async () => pendingDraftFilePaths,
    countDraftsBySourceToday: async () => spentToday,
    countDraftsBySourcesToday: async () => spentToday,
    hasRecentDraftOfType: async (siteId, actionType, days) => days > 0 && recentDraftTypes.has(actionType),
    submitDraftForApproval: async (siteId, draftId) => (stuckDraftStatus ? null : { id: draftId }),
    getDraft: async (siteId, draftId) => ({ id: draftId, status: stuckDraftStatus || 'draft', branch_name: stuckDraftBranch }),
    updateDraft: async () => null,
    markDraftAbandoned: async (siteId, draftId, reason) => { calls.abandoned.push({ draftId, reason }); },
    // The retryable-in-place counterpart: records the failure without
    // abandoning, so a transient batch failure leaves the draft for the next
    // run. Tracked separately from `abandoned` precisely because the whole
    // point of the distinction is that these two are NOT interchangeable.
    recordMergeFailure: async (siteId, draftId, reason) => { calls.retryable.push({ draftId, reason }); },
    // Feeds ship-pacing.js's convergence cap: finding_id -> how many times it
    // has already been drafted and abandoned for an item-specific reason.
    countFailedAttemptsByFinding: async () => failedAttempts,
  },
});
const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => site },
});
// Phase 5: what's under test in this file is auto-remediation's OWN control
// flow, not the learning log — mocked to an empty map (no generator ever
// demoted) and a no-op recorder, same as every other collaborator here.
// generator-learning.test.js covers the real query/scoring logic against a
// real database.
mock.module(resolve('./generator-learning.js'), {
  namedExports: {
    getLearnedConfidenceMap: async () => learnedMap ?? new Map(),
    recordOutcome: async (siteId, generatorId, outcome) => { recordedOutcomes.push({ generatorId, outcome }); },
    // Feeds ship-pacing.js's applyRefusalCap — mocked to "nothing has ever
    // been refused" (an empty Map), same no-op-collaborator stance as the
    // other two exports above. generator-learning.test.js covers the real
    // query/classification logic against a real database.
    countRefusalsByRecommendation: async () => new Map(),
  },
});
// The real implementation (implementers/lib/onboarding-readiness.js) hits a
// real DB via getLatestDesignAgentJob — mocked here the same way every other
// collaborator in this file is, so the default (`onboardingPending = false`
// via reset()) matches every existing test's assumption that onboarding
// analysis has already completed. The two-stage-onboarding describe block
// below flips `onboardingPending` to exercise the gate itself.
mock.module(resolve('../../implementers/lib/onboarding-readiness.js'), {
  namedExports: { isOnboardingAnalysisPending: async () => onboardingPending },
});
// The shared shipping queue's other lanes — learned-repair's queued intents
// and content-repair's already-prepared file edits (see store/shipping-queue.js,
// migration 148). This module's own real logic (dedupe, state transitions)
// is covered directly by store/shipping-queue.test.js; what's under test
// here is auto-remediation's OWN decision to drain them into this run's
// single batch, so every export is a thin fake driven by the fixtures above.
mock.module(resolve('../../store/shipping-queue.js'), {
  namedExports: {
    QUEUE_STATES: { QUEUED: 'queued', PREPARING: 'preparing', PREPARED: 'prepared', SHIPPING: 'shipping', SHIPPED: 'shipped', FAILED: 'failed', SUPERSEDED: 'superseded' },
    // The fixtures (learnedRepairQueueItems/contentRepairQueueItems) list only
    // the fields each test cares about — `source`/`kind` are stamped on here
    // rather than repeated in every fixture literal, since the code under
    // test filters listByState's result by exactly those two fields (real
    // store rows are not source-scoped by the query itself; that filtering
    // is the auto-remediation.js code's own job, which this proves by
    // requiring it to actually happen).
    listByState: async (siteId, state) => (
      state === 'queued' ? learnedRepairQueueItems.map((r) => ({ source: 'learned-repair', ...r }))
        : state === 'prepared' ? contentRepairQueueItems.map((r) => ({ source: 'content-repair', kind: 'file-edits', ...r }))
          : []
    ),
    markShipped: async (id) => { calls.queueShipped.push(id); },
    releaseItem: async (id, opts) => { calls.queueReleased.push({ id, ...opts }); },
    // The file-edits-only slice of today's shared-ceiling spend (see
    // store/shipping-queue.js's own comment on why this is scoped to
    // kind:'file-edits' and kept separate from countDraftsBySourcesToday).
    countShippedFileEditsToday: async () => fileEditsSpentToday,
  },
});
mock.module(resolve('../../agent-memory.js'), {
  namedExports: {
    recordFixOutcome: async (args) => { calls.fixOutcomes.push(args); return 1; },
    // Not exercised by this file (nothing here ever gets far enough to look
    // one up — that's learned-repair-intercept.test.js's own contract), but
    // learned-repair.js imports it at module load time, and something in
    // this test's own graph now transitively imports learned-repair.js.
    findPortableRepairs: async () => { throw new Error('must not be reached from auto-remediation.test.js'); },
  },
});
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: {
    generateDraft: async (siteId, { generatorId, findingId, findingOrigin }) => {
      lastGeneratorId = generatorId;
      calls.findingOrigins.push(findingOrigin);
      const custom = generateError(++generateAttempts);
      if (custom) throw custom;
      // The shape real generators use to decline an item honestly — e.g. schema.js's
      // "had no real data on the page" and expand-content.js's ungrounded-citations
      // refusal, both { status: 400, userFacing: true }.
      if (staleOn(generatorId)) {
        throw Object.assign(new Error(`${generatorId} already has real data — nothing left to fix`), { status: 400, userFacing: true, refusal: true, stale: true });
      }
      if (refuseOn(generatorId)) {
        throw Object.assign(new Error(`refusing to draft ${generatorId} — no real data`), { status: 400, userFacing: true });
      }
      // github/client.js's typed rate-limit error, as it reaches this loop
      // after propagating up through the implementer's apply().
      if (rateLimitOn(generatorId)) {
        throw Object.assign(new Error('GitHub rate limit reached'), { rateLimited: true });
      }
      if (failOn(generatorId)) throw new Error(`simulated generate failure for ${generatorId}`);
      calls.generated.push(findingId);
      return { id: `d-${findingId}`, status: 'draft', content: {} };
    },
    approveAndPublishDraftUnattended: async (siteId, draftId) => {
      calls.approved.push(draftId);
      const applyErrorMessage = applyFailureMessageOn(lastGeneratorId);
      if (applyErrorMessage) return { id: draftId, apply_error: applyErrorMessage };
      // approveAndPublishDraft ends in markDraftPrOpened whenever the resolved
      // implementer exposes mergeToStage — which every real one does — so in
      // production it usually returns with the PR ALREADY open. `approveOpensPr`
      // switches between that and the rarer stopped-at-branch_pushed shape.
      return approveOpensPr
        ? { id: draftId, branch_name: `auto/${draftId}`, pr_number: 47 }
        : { id: draftId, branch_name: `auto/${draftId}` };
    },
    // The manual "Push Branch" retry the unattended path now reuses to
    // resume a draft stranded at 'approved' by a failed apply(). This same
    // mocked export also stands in for github-ops.js's real pushDraftBranch
    // in its OTHER call shape — the file-edits queue drain (content-repair,
    // template-capability-repair) calls it as (site, draftLike, files,
    // target) directly, never through the resume-a-stranded-draft path
    // above, so the two are told apart by arity. draftLike.id is
    // `${source}-${queueId}` (auto-remediation.js's own format), so the
    // numeric id is whatever trails the LAST hyphen.
    pushDraftBranch: async (a, b, files, target) => {
      if (files !== undefined) {
        const queueId = Number(String(b.id).split('-').pop());
        calls.branchPushRetries.push(b.id);
        if (contentRepairPushOn(queueId)) return { ok: false, error: `simulated push failure for file-edits item ${queueId}` };
        return { ok: true, branchName: target.branchName };
      }
      const draftId = b;
      calls.branchPushRetries.push(draftId);
      return { id: draftId, branch_name: `retry/${draftId}` };
    },
    openDraftPr: async (siteId, draftId) => {
      calls.prsOpened.push(draftId);
      return { id: draftId, pr_number: 1 };
    },
    autoSelectMetaTitle: () => null,
    // Batching now opens ONE PR per run (not one per item — see
    // github-ops.js's beginBatchPush) via finalizeBatchPr, called once
    // after the loop with every draft id that made it to 'branch_pushed'.
    // Mocked to succeed by default and record every id it was asked to
    // finalize into `calls.prsOpened`, same array/semantics the old
    // per-item openDraftPr mock above used, so existing assertions ("every
    // shipped draft reaches an open PR") still hold under the new
    // one-call-per-batch shape. `finalizeBatchFails` lets a test simulate
    // the batch's one shared push/PR failing instead.
    finalizeBatchPr: async (site, branchName, draftIds) => {
      calls.batchFinalizeCalls.push({ branchName, draftIds });
      if (finalizeBatchFails) return { ok: false, error: finalizeBatchError, rateLimited: finalizeBatchRateLimited };
      calls.prsOpened.push(...draftIds);
      return { ok: true, pushed: draftIds.length, prNumber: 1, prUrl: 'https://github.com/acme/site/pull/1' };
    },
  },
});

const { autoRemediateSafeRecommendations, shipDraftForRecommendation } = await import('./auto-remediation.js');

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

// Two-stage onboarding: connect-repo grants auto_remediation_enabled AND
// queues the whole-site analysis job in the same moment, but this loop must
// still wait for that analysis to finish before opening a single PR — being
// enabled is necessary but not sufficient the very same pass a brand-new
// tenant connects its repo.
describe('auto-remediation — two-stage onboarding gate', () => {
  beforeEach(reset);

  test('onboarding analysis still pending -> does nothing, even though auto_remediation_enabled is true', async () => {
    onboardingPending = true;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'onboarding-analysis-pending');
    assert.equal(calls.generated.length, 0, 'must not open any PR while onboarding analysis is still in flight');
  });

  test('onboarding analysis terminal (not pending) -> proceeds normally', async () => {
    onboardingPending = false;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);
    assert.notEqual(result.stoppedReason, 'onboarding-analysis-pending');
    assert.equal(calls.generated.length, 1);
  });

  test('the injectable onboardingAnalysisPending option is honored independently of the mocked module default', async () => {
    // onboardingPending (module-level mock) is false via reset(), but the
    // explicit per-call option must still win — same DI pattern as every
    // other injectable dependency in this codebase.
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1, { onboardingAnalysisPending: async () => true });
    assert.equal(result.stoppedReason, 'onboarding-analysis-pending');
    assert.equal(calls.generated.length, 0);
  });

  test('disabled still wins over onboarding-pending when both are true — the more fundamental reason is reported', async () => {
    site.auto_remediation_enabled = false;
    onboardingPending = true;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'disabled');
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

  // File-level sibling to the finding_id dedup above: a DIFFERENT finding
  // targeting a file that already has an earlier draft sitting on a
  // still-open, unmerged PR must also be skipped — otherwise a second day's
  // unattended run silently regenerates that file from stale content
  // (confirmed live: a page's title flip-flopped across two unmerged PRs,
  // and a duplicate FAQ schema landed on top of a still-pending one).
  test('a recommendation whose resolved file already has a pending draft on an open PR is skipped', async () => {
    site.url_file_map = { pages: { '/p1': { file: 'src/pages/p1.njk' }, '/p2': { file: 'src/pages/p2.njk' } } };
    recommendations = [rec(1), rec(2)];
    pendingDraftFilePaths = new Set(['src/pages/p1.njk']);
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f2']);
  });

  test('a recommendation whose page has no resolvable file is unaffected by the pending-file guard', async () => {
    // No url_file_map configured — resolveFile(site, '/p1') returns null,
    // same as a page this site never mapped at all. Must not be treated as
    // colliding with anything.
    recommendations = [rec(1)];
    pendingDraftFilePaths = new Set(['src/pages/p1.njk']);
    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f1']);
  });

  // Prompt 7 audit, section 9: `source` is overwritten with the shipping
  // mechanism's own label ('auto-remediation') below, which would silently
  // discard the recommendation's real detecting agent unless it's threaded
  // through separately as findingOrigin — the thing fix-verifications.js's
  // isVerifiableDraft() actually needs to know whether a real tag-based 48h
  // recheck exists for this fix.
  test('passes the recommendation\'s real detecting agent through as findingOrigin, distinct from source', async () => {
    recommendations = [rec(1, { detectingAgents: ['content-gap', 'ai-visibility'] })];
    await autoRemediateSafeRecommendations(1);
    assert.deepEqual(calls.findingOrigins, ['content-gap'], 'the FIRST detecting agent is the one recorded as the origin');
  });

  test('a recommendation with no detecting_agents (e.g. an older row) passes null, not a crash', async () => {
    const r = rec(1);
    delete r.detecting_agents;
    recommendations = [r];
    await autoRemediateSafeRecommendations(1);
    assert.deepEqual(calls.findingOrigins, [null]);
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

  // The bug this guards: content-repair and template-capability-repair ship
  // file edits straight through shipping_queue and never create a `drafts`
  // row, so countDraftsBySourcesToday alone is structurally blind to them.
  // countShippedFileEditsToday (mocked here as fileEditsSpentToday) is the
  // queue's own count of exactly that slice, and it must fold into the same
  // budget as ordinary drafts — otherwise those two sources could each ship
  // right up to the ceiling independently and the combined day would exceed
  // it.
  test('file-edits work already shipped today (content-repair / template-capability-repair) consumes the same shared budget as drafts', async () => {
    site.auto_remediation_daily_limit = 3;
    spentToday = 1; // one ordinary draft already shipped
    fileEditsSpentToday = 2; // two file-edits items already shipped, never a drafts row
    recommendations = [rec(1), rec(2), rec(3)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.spentToday, 3, 'drafts (1) + file-edits (2) must be summed, not just the drafts half');
    assert.equal(result.shipped, 0, 'limit 3 minus 3 already spent (across both lanes) leaves zero room');
    assert.equal(result.stoppedReason, 'budget-exhausted');
    assert.equal(calls.generated.length, 0);
  });

  test('file-edits spend alone can exhaust the day\'s budget with zero drafts shipped', async () => {
    site.auto_remediation_daily_limit = 2;
    spentToday = 0;
    fileEditsSpentToday = 2;
    recommendations = [rec(1), rec(2)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.spentToday, 2);
    assert.equal(result.stoppedReason, 'budget-exhausted');
    assert.equal(calls.generated.length, 0);
  });
});

// Categories come from recommendation-taxonomy.js's classify() — the same
// grouping the Action Center UI shows (e.g. "Meta Titles", "Broken Links",
// "Blog Opportunities").
//
// Until 2026-09-10 daily-queue.js's GENERATOR_SHARE_CAP capped any one
// generator at 50% of the day's merit pass, specifically so a category with
// sheer volume (e.g. 472 open GEO Signals items) couldn't consume the whole
// budget and starve a category with only 1-3 open items. That protection
// was deliberately removed per explicit product decision: a category
// carrying a genuinely dominant, high-priority backlog should be free to
// claim as much of the day as it earns on merit rather than be throttled
// back for variety's sake — see GENERATOR_SHARE_CAP's own comment in
// daily-queue.js. Higher-severity-tier work (critical-technical, on-page)
// still always wins its slot ahead of a lower tier regardless of category
// size — that ordering comes from severity-tiers.js/growth-scoring.js, a
// different axis than the removed cap, and TIER_FLOOR still guarantees a
// minimum presence for the lowest tiers (content/cleanup).
describe('auto-remediation — category-diverse selection', () => {
  beforeEach(reset);

  test('the full budget fills from the highest-scoring category with no per-category cap, while higher-tier work still wins its slot first', async () => {
    site.auto_remediation_daily_limit = 8;
    recommendations = [
      // detectingAgents matters here — 'opportunity' (rec()'s default) hits
      // recommendation-taxonomy.js's source-level wildcard and collapses
      // everything into one category regardless of type, so each generator
      // here is paired with the real agent that actually detects it.
      ...Array.from({ length: 10 }, (_, i) => rec(i + 1, { type: 'meta-title', detectingAgents: ['content-gap'] })), // -> "Meta Titles", tier 2 (on-page)
      rec(11, { type: 'broken-link-fix', detectingAgents: ['technical-seo'] }), // -> "Broken Links", tier 1 (critical-technical) — wins its slot first
      rec(12, { type: 'broken-link-fix', detectingAgents: ['technical-seo'] }),
      rec(13, { type: 'faq', detectingAgents: ['content-gap'] }), // -> "FAQ Opportunities", tier 2 — no longer guaranteed a slot once the cap is gone
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 8, 'the full 8-item budget is used even though one category alone had 10 candidates');
    const metaTitleShipped = calls.generated.filter((f) => ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'].includes(f));
    assert.ok(metaTitleShipped.length > 5, `Meta Titles is no longer capped at 5 — got ${metaTitleShipped.length}, expected it free to exceed the old cap`);
    assert.ok(calls.generated.includes('f11'), 'critical-technical (broken-link-fix) still wins a slot ahead of the lower-tier bulk category');
  });
});

describe('auto-remediation — circuit breaker', () => {
  beforeEach(reset);

  // Replaces the old "5 consecutive failures of ANY kind halts the whole run"
  // behavior: 5 identical 'bad' failures are an INDIVIDUAL-item pattern (a
  // generic Error, no systemic signature), so they quarantine the 'bad'
  // generator after FAMILY_FAILURE_LIMIT (2) — not after 5, and never as a
  // whole-run breaker. The freed budget goes straight to the other,
  // unrelated recommendations in the same run instead of being lost.
  test('a repeating individual failure quarantines its generator after 2, not 5, and the run keeps going', async () => {
    recommendations = [
      rec(1, { type: 'bad' }), rec(2, { type: 'bad' }), rec(3, { type: 'bad' }),
      rec(4, { type: 'bad' }), rec(5, { type: 'bad' }), rec(6), rec(7),
    ];
    failOn = (type) => type === 'bad';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 2, 'only the two attempts it took to establish the pattern are counted as failed');
    assert.equal(result.quarantined, 3, 'recommendations 3, 4 and 5 are quarantined without being attempted');
    assert.equal(result.shipped, 2, 'the two unrelated, healthy recommendations still ship');
    assert.equal(result.stoppedReason, null, 'an individual failure pattern is never reported as a run-stopping fault');
    assert.equal(result.attempted, 4, '2 failed attempts + 2 successful ones; the quarantined 3 never call generateDraft');
    assert.equal(calls.generated.length, 2);
  });

  test('a success resets nothing that matters here — quarantine is per-generator, not a global streak', async () => {
    recommendations = [
      rec(1, { type: 'bad' }), rec(2), rec(3, { type: 'bad' }),
      rec(4), rec(5, { type: 'bad' }), rec(6),
    ];
    failOn = (type) => type === 'bad';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'individual failures never stop the run');
    assert.equal(result.shipped, 3, 'every non-bad item still ships');
    assert.equal(result.failed, 2, '\'bad\' quarantines itself after its 2nd failure (recs 1 and 3)');
    assert.equal(result.quarantined, 1, 'rec 5 (also \'bad\') is skipped once quarantined');
    assert.equal(result.attempted, 5, '2 failed bad + 3 successful others; rec 5 is never attempted');
  });

  // The breaker exists for faults where every later attempt is also doomed.
  // A rate limit is the opposite: the identical attempt succeeds once the
  // budget refills. Counting it as a fault reports "revoked token / moved
  // default branch" for what is really a one-hour wait — the exact
  // misreading behind 2026-09-01's abandoned drafts.
  test('a rate limit stops the run WITHOUT counting as a failure or tripping the breaker', async () => {
    recommendations = [rec(1, { type: 'limited' }), rec(2), rec(3)];
    rateLimitOn = (type) => type === 'limited';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'github-rate-limited');
    assert.notEqual(result.stoppedReason, 'circuit-breaker', 'never reported as a systemic fault');
    assert.equal(result.failed, 0, 'the limited item is not scored as a failure');
    assert.equal(result.attempted, 1, 'stops immediately — the rest share the same exhausted token');
    assert.deepEqual(calls.abandoned, [], 'nothing is abandoned; every candidate stays open for the next run');
  });

  // The other half of the redesign: real infrastructure faults must still
  // stop the run, distinctly from the per-item quarantine above. Spread
  // across three DIFFERENT generators (so family quarantine never gets a
  // chance to fire first — each generator only fails once on its own) and a
  // real systemic signature (401 = dead credentials), matching
  // failure-policy.js's classifyShipFailure.
  test('genuinely systemic failures (dead GitHub credentials) still stop the whole run', async () => {
    recommendations = [
      rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' }), rec(3, { type: 'alt-text' }), rec(4),
    ];
    generateError = () => Object.assign(new Error('Bad credentials'), { status: 401 });

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'circuit-breaker-systemic', 'a real infra fault stops the run, unlike a per-item pattern');
    assert.equal(result.attempted, 3, 'stops after SYSTEMIC_FAILURE_LIMIT (3) consecutive systemic failures');
    assert.equal(result.shipped, 0);
    assert.equal(result.quarantined, 0, 'nothing was quarantined — this was never treated as a per-item pattern');
  });
});


// Regression guard for a bug found on the first real end-to-end run, where
// draft 698 opened PR #47 on zunkireelabs-web and was recorded as a FAILURE:
// approveAndPublishDraft used to open the PR per item, and this loop's own
// "did it open the PR yet?" check threw when it had already been opened —
// counting a fully successful item as failed, and tripping the circuit
// breaker after 3 such successes.
//
// Batching removed the per-item branch that bug lived in entirely: every
// item now ships with deferPr (approveAndPublishDraft never opens a PR per
// item at all — see its own comment on deferPr), and exactly ONE PR opens
// for the whole run via finalizeBatchPr, once, after the loop. `approveOpensPr`
// is gone as a meaningful toggle for this reason — nothing this loop does
// depends any more on whether approveAndPublishDraftUnattended's mock
// happens to include a pr_number.
describe('batched PR opening', () => {
  beforeEach(reset);

  test('opens exactly ONE PR for the whole batch, not one per item', async () => {
    recommendations = [rec(1), rec(2), rec(3), rec(4)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1, 'finalizeBatchPr is called exactly once for the whole run');
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds, ['d-f1', 'd-f2', 'd-f3', 'd-f4']);
    assert.deepEqual(calls.prsOpened, ['d-f1', 'd-f2', 'd-f3', 'd-f4'], 'every shipped draft still reaches an open PR');
    assert.equal(result.shipped, 4, 'every item ships');
    assert.equal(result.failed, 0);
    assert.equal(result.stoppedReason, null, 'the breaker must not fire on successes');
  });

  test('a run with nothing to ship never calls finalizeBatchPr at all', async () => {
    recommendations = [];
    await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 0);
  });

  // An UNATTRIBUTABLE batch failure is transient by construction: this one
  // call fails every pending item together regardless of their content, so a
  // failure nothing can be pinned on says nothing about any single item.
  // These drafts keep their real, Quality-Gate-passed commits and re-attempt
  // on the next run instead of being destroyed — the 2026-09-01 shape, where
  // 80 drafts died on a sanitized "This pull request could not be opened
  // right now" that carried no evidence of its own transience.
  test('an unattributable batch push/PR failure leaves every pending item re-attemptable, not abandoned', async () => {
    finalizeBatchFails = true;
    recommendations = [rec(1), rec(2)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 0, 'nothing actually reached GitHub');
    assert.equal(result.failed, 0, 'a shared batch failure is not scored against the items it happened to catch');
    assert.deepEqual(calls.prsOpened, [], 'no PR was opened');
    assert.deepEqual(calls.abandoned, [], 'no draft is destroyed for a failure that says nothing about it');
    assert.deepEqual(
      calls.retryable.map((a) => a.draftId).sort(), ['d-f1', 'd-f2'],
      'both record the failure in place, which reopens their finding for the next run',
    );
    assert.equal(result.stoppedReason, 'batch-push-failed-transient', 'never mislabelled as a rate limit, which the headers did not report');
  });

  // The 2026-09-01 outage in miniature. This one call fails the whole batch
  // at once by design (one shared push, one shared PR), so whatever it
  // decides applies to every pending item together — which is exactly why
  // deciding "abandon" on a transient failure was so expensive: an hour of
  // exhausted GitHub quota destroyed 54 Quality-Gate-passed drafts in a
  // single call, each of which would have shipped on the next pass.
  test('a RATE-LIMITED batch failure leaves every pending item re-attemptable instead of abandoning it', async () => {
    finalizeBatchFails = true;
    finalizeBatchRateLimited = true;
    recommendations = [rec(1), rec(2)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 0, 'still nothing actually reached GitHub');
    assert.equal(result.failed, 0, 'a rate limit is a statement about timing, not a fault of these items');
    assert.deepEqual(calls.abandoned, [], 'nothing is abandoned for a failure that resolves itself');
    assert.deepEqual(
      calls.retryable.map((a) => a.draftId).sort(), ['d-f1', 'd-f2'],
      'both drafts record the failure in place (apply_error), which reopens their finding for the next run',
    );
    assert.equal(result.stoppedReason, 'github-rate-limited', 'reported as its own reason, never as a circuit-breaker fault');
  });

  // The exact live string that destroyed 80 drafts on this instance. It is
  // sanitized before it reaches here, so it carries no rate-limit flag and no
  // recognizable cause — the shape that must not be read as an item fault.
  test('a sanitized PR-open failure is re-attemptable, not abandoned', async () => {
    finalizeBatchFails = true;
    finalizeBatchRateLimited = false;
    finalizeBatchError = 'This pull request could not be opened right now — our team has been notified. (ref: 7f3a91)';
    recommendations = [rec(1), rec(2)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.abandoned, [], 'no Quality-Gate-passed commit is thrown away for an unattributable failure');
    assert.deepEqual(calls.retryable.map((a) => a.draftId).sort(), ['d-f1', 'd-f2']);
    assert.equal(result.failed, 0);
  });

  // The counterpart: a cause that DEMONSTRABLY cannot resolve itself still
  // ends in abandonment, or the pipeline would re-attempt doomed work every
  // run forever. A missing PAT is the real example — 40 drafts on this
  // instance — and it is exactly what a naive "any batch failure is
  // transient" rule would have retried indefinitely.
  test('a batch failure with a demonstrably permanent cause still abandons', async () => {
    finalizeBatchFails = true;
    finalizeBatchRateLimited = false;
    finalizeBatchError = 'No GitHub PAT set in env var "GITHUB_PAT"';
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 1);
    assert.deepEqual(calls.retryable, [], 'nothing is left to retry against a config gap that cannot fix itself');
    assert.deepEqual(calls.abandoned.map((a) => a.draftId), ['d-f1']);
    assert.match(
      calls.abandoned[0].reason, /GITHUB_PAT/,
      'the recorded reason names the real cause, so the fix is actionable without reading logs',
    );
  });
});

// The shared shipping queue drain — learned-repair's queued intents and
// content-repair's already-prepared file edits join THIS SAME batch, rather
// than either one opening its own PR (the two bypasses closed by routing
// both through store/shipping-queue.js). See that module and
// learned-repair.js/repair-site-content-live.js's own module comments.
describe('shared shipping queue drain — learned-repair', () => {
  beforeEach(reset);

  test('a queued learned-repair item is generated, shipped, and joins the SAME single PR as ordinary work', async () => {
    recommendations = [rec(1)];
    learnedRepairQueueItems = [{ id: 501, generator_id: 'alt-text', finding_id: 'lr-1', params: { page: '/lr' }, memory_ref_id: 42 }];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1, 'still exactly one PR for the whole run');
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds.sort(), ['d-f1', 'd-lr-1'].sort(), 'the learned-repair draft rides in the SAME batch as ordinary analytics work');
    assert.equal(result.shipped, 2, 'both the ordinary recommendation and the learned-repair item count as shipped');
    assert.deepEqual(calls.queueShipped, [501], 'the queue row is marked shipped once the batch PR is confirmed open');
    assert.equal(calls.fixOutcomes.length, 1);
    assert.deepEqual(calls.fixOutcomes[0], { memoryRefId: 42, outcome: 'success', agentId: 'learned-repair', generatorId: 'alt-text', siteId: 1 });
  });

  test('a learned-repair item ships even on a day with ZERO ordinary analytics work — the batch still begins for it alone', async () => {
    recommendations = [];
    learnedRepairQueueItems = [{ id: 501, generator_id: 'alt-text', finding_id: 'lr-1', params: {}, memory_ref_id: 42 }];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1);
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds, ['d-lr-1']);
    assert.equal(result.shipped, 1);
  });

  test('a failed learned-repair generation is released back to the queue and recorded as a failed reuse against its memory', async () => {
    recommendations = [];
    learnedRepairQueueItems = [{ id: 501, generator_id: 'broken-gen', finding_id: 'lr-1', params: {}, memory_ref_id: 42 }];
    failOn = (type) => type === 'broken-gen';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 1);
    assert.equal(calls.queueShipped.length, 0);
    assert.equal(calls.queueReleased.length, 1);
    assert.equal(calls.queueReleased[0].id, 501);
    assert.equal(calls.queueReleased[0].retryable, false);
    assert.equal(calls.fixOutcomes.length, 1);
    assert.equal(calls.fixOutcomes[0].outcome, 'failure');
    assert.equal(calls.fixOutcomes[0].memoryRefId, 42);
  });

  test('learned-repair items respect the same remaining daily budget — never bypass it', async () => {
    site.auto_remediation_daily_limit = 1;
    recommendations = [rec(1)]; // consumes the only slot
    learnedRepairQueueItems = [{ id: 501, generator_id: 'alt-text', finding_id: 'lr-1', params: {}, memory_ref_id: 42 }];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 1, 'only the one budgeted item ships');
    assert.equal(calls.queueShipped.length, 0, 'the learned-repair item is left queued, not drained past the ceiling');
    assert.equal(calls.queueReleased.length, 0, 'left untouched (still queued) — not released as a failure either, since it was never attempted');
  });
});

describe('shared shipping queue drain — content-repair', () => {
  beforeEach(reset);

  test('a prepared content-repair file-edit item is pushed onto the batch and ships in the same PR, without ever becoming a draft', async () => {
    recommendations = [rec(1)];
    contentRepairQueueItems = [{ id: 701, params: { edits: [{ path: 'src/a.njk', content: 'x' }], commitMessage: 'repair' } }];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1);
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds, ['d-f1'], 'content-repair never creates a drafts row, so it never appears in draftIds');
    assert.ok(calls.branchPushRetries.includes('content-repair-701'), 'its files are pushed onto the same batch branch');
    assert.equal(result.shipped, 2, 'the ordinary recommendation and the content-repair edit both count as shipped');
    assert.deepEqual(calls.queueShipped, [701]);
  });

  test('content-repair alone (no ordinary work, no learned-repair) still produces exactly one PR', async () => {
    recommendations = [];
    contentRepairQueueItems = [{ id: 701, params: { edits: [{ path: 'src/a.njk', content: 'x' }] } }];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1);
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds, [], 'no draft-backed items this run');
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.queueShipped, [701]);
  });

  test('a failed content-repair push is released back to the queue as retryable, not abandoned', async () => {
    recommendations = [];
    contentRepairQueueItems = [{ id: 701, params: { edits: [{ path: 'src/a.njk', content: 'x' }] } }];
    contentRepairPushOn = (id) => id === 701;

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 1);
    assert.equal(calls.queueShipped.length, 0);
    assert.equal(calls.queueReleased.length, 1);
    assert.equal(calls.queueReleased[0].id, 701);
    assert.equal(calls.queueReleased[0].retryable, true, 'a push failure is a plumbing issue, not evidence the repair itself was wrong');
  });

  // The third PR-bypass closed: repair-template-capability.js used to open
  // its OWN dedicated branch/PR directly. It now queues exactly like
  // content-repair (same kind:'file-edits' shape), so it drains through the
  // identical code path — proven here with a DIFFERENT source, alongside a
  // content-repair item in the same run, to show both coexist in one batch.
  test('a template-capability-repair file-edit item ships in the SAME batch as a content-repair item and ordinary work', async () => {
    recommendations = [rec(1)];
    contentRepairQueueItems = [
      { id: 701, source: 'content-repair', params: { edits: [{ path: 'src/a.njk', content: 'x' }] } },
      { id: 702, source: 'template-capability-repair', params: { edits: [{ path: 'src/layouts/service.njk', content: 'y' }] } },
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(calls.batchFinalizeCalls.length, 1, 'still exactly one PR for the whole run');
    assert.deepEqual(calls.batchFinalizeCalls[0].draftIds, ['d-f1']);
    assert.ok(calls.branchPushRetries.includes('content-repair-701'));
    assert.ok(calls.branchPushRetries.includes('template-capability-repair-702'));
    assert.equal(result.shipped, 3, 'the ordinary recommendation plus both file-edits items');
    assert.deepEqual(calls.queueShipped.sort(), [701, 702]);
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

  // Five REAL (non-refusal) faults sharing one generator are exactly the
  // individual-item pattern failure-policy.js's family quarantine exists for
  // — not the systemic breaker (see the dedicated systemic test in the
  // 'auto-remediation — circuit breaker' describe above for the case that
  // still trips it).
  test('five real faults sharing one generator quarantine it after 2, and unrelated work still ships', async () => {
    failOn = (type) => type === 'schema';
    recommendations = [
      rec(1, { type: 'schema' }), rec(2, { type: 'schema' }), rec(3, { type: 'schema' }),
      rec(4, { type: 'schema' }), rec(5, { type: 'schema' }), rec(6), rec(7),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'an individual-item pattern is never reported as a systemic fault');
    assert.equal(result.refused, 0);
    assert.equal(result.failed, 2, 'only the two attempts that established the pattern');
    assert.equal(result.quarantined, 3);
    assert.equal(result.shipped, 2, 'the two unrelated candidates still ship');
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

  test('a stale refusal (generator proves the premise is already gone) closes the recommendation', async () => {
    staleOn = (type) => type === 'schema';
    recommendations = [rec(1, { type: 'schema' }), rec(2)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.refused, 1);
    assert.deepEqual(calls.closed, [1], 'the stale recommendation is closed so tomorrow\'s run does not re-refuse it');
  });

  test('an ordinary refusal (not stale) never closes the recommendation', async () => {
    refuseOn = (type) => type === 'schema';
    recommendations = [rec(1, { type: 'schema' })];

    await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.closed, [], 'a refusal that says nothing about the recommendation being resolved must leave it open');
  });
});

// Regression coverage for the 2026-08-30 fix: implementer.apply() failures
// that reach shipDraftForRecommendation only as a plain apply_error MESSAGE
// (approveAndPublishDraftUnattended's !ok path never persists {reason} — see
// auto-remediation.js's own comment on this) were, until this fix, always
// counted as genuine failures. Two known-recurring, non-systemic per-item
// conditions — a stale exact-match anchor, and a page/marker never onboarded
// into url_file_map — repeatedly tripped the circuit breaker on site 1 and
// halted otherwise-healthy runs with budget left unused.
// Regression coverage for 2026-09-07: one ship attempt failed with "GitHub
// App is not configured" while two sibling items in the SAME process
// authenticated fine seconds apart, and the credential resolved cleanly on
// every check afterwards. No code path explains that (dotenv is loaded before
// any other import, nothing outside tests mutates those vars, appConfigured()
// is a pure sync env read), so there is no root cause to fix — but the
// CONSEQUENCE is fixable: without a retry, one unexplained blip abandons the
// draft and parks the recommendation at NEEDS_HUMAN, which is deliberately
// not auto-retryable, so a human has to notice and requeue it by hand.
describe('shipDraftForRecommendation — credential failures get exactly one automatic retry', () => {
  beforeEach(reset);

  test('a credential failure that resolves on retry ships normally instead of parking at NEEDS_HUMAN', async () => {
    let attempts = 0;
    applyFailureMessageOn = () => {
      attempts += 1;
      return attempts === 1 ? 'GitHub App is not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64' : null;
    };
    recommendations = [rec(1, { type: 'meta-title' })];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(attempts, 2, 'the failed attempt is retried exactly once');
    assert.equal(result.shipped, 1, 'the retry succeeded, so the item ships in the same run — no human requeue needed');
    assert.equal(result.failed, 0);
    assert.equal(result.refused, 0);
  });

  test('a credential failure that persists is retried only ONCE, then reported honestly — a genuinely absent credential is never retried forever', async () => {
    let attempts = 0;
    applyFailureMessageOn = () => {
      attempts += 1;
      return 'GitHub App is not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64';
    };
    recommendations = [rec(1, { type: 'meta-title' })];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(attempts, 2, 'exactly one retry — never an unbounded loop against a credential that genuinely is not there');
    assert.equal(result.shipped, 0, 'a genuinely missing credential still fails, and still surfaces for a human');
  });

  test('a NON-credential apply failure is never retried — only this specific class gets the second attempt', async () => {
    let attempts = 0;
    applyFailureMessageOn = () => {
      attempts += 1;
      return 'No markers configured for "https://example.com/" — add them to url_file_map.';
    };
    recommendations = [rec(1, { type: 'analytics-install' })];

    await autoRemediateSafeRecommendations(1);

    assert.equal(attempts, 1, 'an ordinary per-item config gap must not pay a second GitHub write attempt');
  });
});

describe('shipDraftForRecommendation apply-failure classification', () => {
  beforeEach(reset);

  test('a stale exact-match anchor (schema-repair/alt-text source drift) refuses and closes, and does not trip the breaker', async () => {
    applyFailureMessageOn = (type) => type === 'schema-repair'
      ? '1 anchor(s) no longer found verbatim in src/pages/about.njk — the source may have changed since this draft was generated. Regenerate the draft, or edit src/pages/about.njk manually.'
      : null;
    recommendations = [
      rec(1, { type: 'schema-repair' }), rec(2, { type: 'schema-repair' }), rec(3, { type: 'schema-repair' }),
      rec(4, { type: 'schema-repair' }), rec(5, { type: 'schema-repair' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'a stale anchor is a known per-item condition, not a systemic fault');
    assert.equal(result.refused, 5);
    assert.equal(result.shipped, 1, 'the healthy item after the five stale ones still ships');
    assert.deepEqual(calls.closed, [1, 2, 3, 4, 5], 'each stale-anchor recommendation is closed so it is not retried forever');
  });

  test('a never-onboarded page/marker (no-file-mapping / no markers configured) refuses but stays open', async () => {
    applyFailureMessageOn = (type) => type === 'analytics-install'
      ? 'No markers configured for "https://zunkireelabs.com/" — add e.g. {"analyticsScriptGa4":"ANALYTICSSCRIPTGA4"} to url_file_map.defaults.placements["analytics-install"].markers.'
      : null;
    recommendations = [
      rec(1, { type: 'analytics-install' }), rec(2, { type: 'analytics-install' }), rec(3, { type: 'analytics-install' }),
      rec(4, { type: 'analytics-install' }), rec(5, { type: 'analytics-install' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'a missing per-page config entry is a known onboarding gap, not a systemic fault');
    assert.equal(result.refused, 5);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.closed, [], 'unlike a stale anchor, the underlying issue is still real — never close it silently');
  });

  // trust-compliance.js deliberately files a missing-tracker finding even
  // with no stored ID, so a human can generate the draft and fill in the
  // placeholder by hand — but that means an unattended attempt at the SAME
  // finding hits this refusal identically forever until they do. Must never
  // trip the breaker, same as the two known per-item conditions above.
  test('an unverified placeholder field (missing tracking ID) refuses but stays open', async () => {
    applyFailureMessageOn = (type) => type === 'analytics-install'
      ? 'This analytics-install draft has 1 unverified placeholder field(s) (trackingId) — the site\'s real tracking ID wasn\'t given. Fill it in manually (edit the draft) before this can be applied.'
      : null;
    recommendations = [
      rec(1, { type: 'analytics-install' }), rec(2, { type: 'analytics-install' }), rec(3, { type: 'analytics-install' }),
      rec(4, { type: 'analytics-install' }), rec(5, { type: 'analytics-install' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'a placeholder waiting on a human is a known condition, not a systemic fault');
    assert.equal(result.refused, 5);
    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.closed, [], 'the recommendation stays open — a human can still fix it by hand at any time');
  });

  // An unrecognized apply-failure message shape is a genuine (non-refusal)
  // failure, but repeating for the same generator is still an individual-item
  // pattern, not proof of a systemic fault — quarantined after 2, same as
  // every other repeating per-item failure shape.
  test('an apply failure with no recognized message shape quarantines its generator after 2, not 5', async () => {
    applyFailureMessageOn = (type) => type === 'qa-content' ? 'upstream GitHub API returned 503' : null;
    recommendations = [
      rec(1, { type: 'qa-content' }), rec(2, { type: 'qa-content' }), rec(3, { type: 'qa-content' }),
      rec(4, { type: 'qa-content' }), rec(5, { type: 'qa-content' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'a repeating per-item shape is never reported as a systemic fault');
    assert.equal(result.refused, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.quarantined, 3);
    assert.equal(result.shipped, 1, 'the unrelated 6th recommendation still ships');
    assert.equal(result.attempted, 3);
  });

  // The design-integrity gate's replacement for the human sign-off removed
  // from validateAutoRemediationRequest (see routes/auto-remediation-toggle.
  // test.js): design-drift.js's checkDesignIntegrityGate now runs
  // automatically, per draft, inside backend.js/frontend.js's apply(). A
  // confirmed role-mismatch surfaces here in the exact same
  // no-branch-pushed/apply_error shape the two tests above already cover —
  // and, like those, MUST be classified a refusal, not a fault. Without this
  // classification, a real defect in a site's ONE shared design profile
  // would fail several consecutive recommendations identically (they all
  // check the same profile) and trip the circuit breaker, halting every
  // OTHER, unrelated recommendation's shipping for the rest of the run —
  // recreating, via the breaker, the exact whole-site blocking behavior
  // removing the human sign-off gate was meant to end.
  test('a design-integrity role-mismatch refuses that recommendation only, and does not trip the breaker', async () => {
    applyFailureMessageOn = (type) => type === 'faq'
      ? 'typography.body uses classes this site only ever uses for its eyebrow.'
      : null;
    recommendations = [
      rec(1, { type: 'faq' }), rec(2, { type: 'faq' }), rec(3, { type: 'faq' }),
      rec(4, { type: 'faq' }), rec(5, { type: 'faq' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, null, 'a confirmed role-mismatch is a known per-item condition, not a systemic fault');
    assert.equal(result.refused, 5, 'all five design-invalid recommendations are refused individually');
    assert.equal(result.shipped, 1, 'the one recommendation unaffected by the profile defect still ships and can still produce a PR');
  });
});

// Publishing cadence for net-new content (sites.blog_min_gap_days, migration
// 107). The daily budget can't express this on its own: 28 open blog-outline
// recommendations are 28 legitimate candidates as far as it is concerned.
// Proves the cap is actually WIRED into the run, not merely unit-tested in
// ship-pacing.js: without this, a correct rule that nothing calls would look
// exactly like a working one.
// The loop that could never converge, found while auditing why only ~32 of a
// possible 60 ship per day.
//
// generateDraft is idempotent per finding, so a retry gets the EXISTING draft
// back. recordApplyFailure deliberately parks a draft at 'approved' with an
// apply_error so "Push Branch" stays retryable, and getDraftedFindingIds
// deliberately treats an unresolved apply_error as "not handled" so the
// finding reopens. Both are correct alone; together they meant the unattended
// loop re-picked the finding every run, got the stuck draft, failed to submit
// it, and recorded a FAILURE — five of which halt the site's entire run.
// Live on site 1: 8 expand-content drafts stuck since 2026-08-28, 19 failures,
// and nothing ever re-ran the apply() that had actually failed.
describe('autoRemediateSafeRecommendations — resuming a stranded draft', () => {
  beforeEach(reset);

  test("a draft stranded at 'approved' resumes by re-running apply, not by regenerating", async () => {
    stuckDraftStatus = 'approved';
    recommendations = [rec(1)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.branchPushRetries, ['d-f1'], 'reuses the same retry the UI offers by hand');
    assert.equal(result.shipped, 1, 'it ships — this is work that was being thrown away every run');
    assert.equal(result.failed, 0, 'and is never counted as a failure that could trip the breaker');
  });

  test("a draft already at 'branch_pushed' on THIS run's branch needs no work — the batch PR step covers it", async () => {
    stuckDraftStatus = 'branch_pushed';
    // Same shape batchBranchName(site) produces for site 1 today.
    stuckDraftBranch = `action-center/batch-1-${new Date().toISOString().slice(0, 10)}`;
    recommendations = [rec(1)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.branchPushRetries, [], 'apply already succeeded; re-running it would be wasted work');
    assert.equal(result.shipped, 1);
  });

  // The repo's own recorded lesson for this file: never leave a
  // partially-failed draft sitting in a non-terminal status.
  // A commit on a PRIOR day's branch is a ghost: queueing it would have the
  // batch mark it pr_opened against a PR that does not contain its change.
  test("a 'branch_pushed' draft from an older branch is reset, never queued as if it had shipped", async () => {
    stuckDraftStatus = 'branch_pushed';
    stuckDraftBranch = 'action-center/batch-1-2020-01-01';
    recommendations = [rec(1)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.abandoned.map((a) => a.draftId), ['d-f1']);
    assert.equal(result.shipped, 0, 'nothing is reported as shipped for a commit that is not on the branch');
  });

  // generateDraft is idempotent per finding, so the cron gets back exactly the
  // draft a person is reviewing. Resetting it would destroy their work.
  test('a draft awaiting human review is left completely untouched — not shipped, not abandoned', async () => {
    stuckDraftStatus = 'submitted_for_approval';
    recommendations = [rec(1)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.abandoned, [], "a human's in-flight draft is never destroyed by the loop");
    assert.equal(result.shipped, 0);
    assert.equal(result.refused, 1);
  });

  test('any other stuck state is abandoned for a clean retry, and reported as a refusal not a failure', async () => {
    stuckDraftStatus = 'some-unrecognized-state';
    recommendations = [rec(1)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.abandoned.map((a) => a.draftId), ['d-f1'], 'reset so the next run can generate a clean draft');
    // Counted as a refusal, not a fault. (`failed` deliberately counts
    // refusals too, so a run never overstates what landed — see
    // "refusals are still counted in failed" above; what matters here is
    // that it does NOT feed the circuit breaker.)
    assert.equal(result.refused, 1, 'one item\'s state problem is not evidence the pipeline is broken');
  });

  test('a stranded draft does not trip the circuit breaker, however many there are', async () => {
    stuckDraftStatus = 'some-unrecognized-state';
    recommendations = [rec(1), rec(2), rec(3), rec(4), rec(5), rec(6), rec(7)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.notEqual(result.stoppedReason, 'circuit-breaker', 'seven stranded drafts must not look like a systemic fault');
    assert.equal(result.refused, 7, 'every one is attempted and reset, none halts the run');
  });
});

// Review finding: shipDraftForRecommendation's stranded-draft resume only
// ever checked the commit against a `batchBranch` that batched callers pass
// (auto-remediation.js's own loop always does). learned-repair.js calls this
// function directly with NO deferPr/batchBranch — a genuinely non-batched,
// single-item ship, whose apply() moves the real ref directly with no batch
// overlay involved. Before this fix, `currentBatchBranch` was always null for
// that caller, so a draft that had truly, successfully pushed (only the
// PR-open step remaining) was misclassified STRANDED and abandoned —
// discarding real, already-shipped work.
describe('shipDraftForRecommendation — resuming a NON-batched (single-item) ship', () => {
  beforeEach(reset);

  test('a branch_pushed draft on its OWN branch opens its PR directly — no batch step is ever coming for it', async () => {
    stuckDraftStatus = 'branch_pushed';
    stuckDraftBranch = 'auto/d-f1'; // the draft's own branch — no batching involved

    await shipDraftForRecommendation(1, { generatorId: 'meta-title', params: {}, findingId: 'f1', source: 'learned-repair' });

    assert.deepEqual(calls.prsOpened, ['d-f1'], 'the commit is already live — only the PR-open step is outstanding, and no batch finalize will ever run for this single-item call');
    assert.deepEqual(calls.abandoned, [], 'never discarded');
  });
});

describe('autoRemediateSafeRecommendations — convergence cap', () => {
  beforeEach(reset);

  test('stops re-drafting a finding that has already failed the cap number of times', async () => {
    failedAttempts = new Map([['f2', 3]]);
    recommendations = [rec(1), rec(2), rec(3)];

    const result = await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.generated, ['f1', 'f3'], 'the repeat-offender costs no generation call at all');
    assert.equal(result.shipped, 2);
  });

  test('a capped finding is held, never closed — it stays open for a human', async () => {
    failedAttempts = new Map([['f1', 9]]);
    recommendations = [rec(1)];

    await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.generated, []);
    assert.deepEqual(calls.closed, [], 'holding is not the same as deciding the issue is resolved');
  });
});

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
    // Order, not just membership, changed under growth-value selection: a
    // real on-page fix (meta-title, tier 2) now correctly executes before a
    // net-new blog (tier 4) within the same run, even though the blog
    // survived pacing and holds one of the two slots. The daily budget's
    // survivor set is unaffected (f3/faq is still the one left out) — only
    // the ORDER f1/f2 ship in changed.
    assert.deepEqual(calls.generated, ['f2', 'f1'], 'the on-page fix ships before the lower-tier blog');
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

// The breaker distinguishes a systemic FAULT from an honest REFUSAL. Getting
// that wrong in either direction is expensive: counting refusals as failures
// halts a working system, and counting failures as refusals grinds a broken
// one through its whole budget.
describe('autoRemediateSafeRecommendations — refusal vs failure classification', () => {
  beforeEach(reset);

  test('an explicit refusal flag beats the status heuristic, even on a 5xx', async () => {
    // The Quality Gate's exhaustion throws 502 — the honest HTTP answer, since
    // the generator is upstream of us — but it is a statement about one item's
    // content, not about system health. Before the explicit flag, three
    // unlucky items in a row halted a 30-item day.
    generateError = () => Object.assign(new Error('could not be generated cleanly'), {
      status: 502, userFacing: true, refusal: true, reason: 'quality-gate-exhausted',
    });
    recommendations = [1, 2, 3, 4].map((i) => rec(i));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.attempted, 4, 'all four must be attempted — none of these is a systemic fault');
    assert.equal(result.refused, 4);
    assert.equal(result.stoppedReason, null);
  });

  // The other direction from the explicit-refusal-flag test above: an
  // unflagged server error IS a genuine failure — but every rec() here
  // defaults to the same generatorId ('meta-title'), so a repeat of it is an
  // individual-item pattern (failure-policy.js), not proof of a systemic
  // fault. Quarantined after 2; with no other generator present to backfill
  // from, the run simply has nothing left to try and ends without a
  // run-stopping stoppedReason. See the dedicated systemic-fault test in
  // 'auto-remediation — circuit breaker' for a real infra fault, spread
  // across different generators, which DOES still stop the run.
  test('a genuine 5xx with no refusal flag quarantines its generator after 2, not 5', async () => {
    generateError = () => Object.assign(new Error('upstream exploded'), { status: 500 });
    recommendations = [1, 2, 3, 4, 5, 6, 7].map((i) => rec(i));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, null);
    assert.equal(result.attempted, 2, 'only the 2 attempts needed to establish and quarantine the pattern');
    assert.equal(result.failed, 2);
    assert.equal(result.quarantined, 5, 'every other candidate shares the same (only) generator and is quarantined too');
    assert.equal(result.shipped, 0);
  });

  test('a long run of honest refusals stops the run, but not as a fault', async () => {
    generateError = () => Object.assign(new Error('no real data on the page'), { status: 422, userFacing: true });
    recommendations = Array.from({ length: 12 }, (_, i) => rec(i + 1));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'refusal-streak',
      'never circuit-breaker — to an operator those mean opposite things');
    assert.equal(result.attempted, 8);
    assert.equal(result.refused, 8);
  });

  test('a success resets the refusal streak', async () => {
    // One clean generation in the middle of a long refusal run.
    generateError = (n) => (n === 5 ? null : Object.assign(new Error('declined'), { status: 422, userFacing: true }));
    recommendations = Array.from({ length: 14 }, (_, i) => rec(i + 1));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.shipped, 1);
    assert.equal(result.attempted, 13, 'the streak restarts after the success, so 4 + 1 + 8 are attempted');
  });
});

describe('Phase 5 — learning actually changes what the loop does, not just what it reports', () => {
  beforeEach(reset);

  test('a generator the learned map has demoted is excluded from this run, and a still-healthy one still ships', async () => {
    learnedMap = new Map([['meta-title', { demote: true, reason: '3 of 4 recent attempts failed or were rejected — held for review until this improves' }]]);
    recommendations = [rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' })];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 1, 'only the non-demoted generator ships');
    assert.deepEqual(calls.generated, ['f2']);
  });

  test('every shipped item records a "shipped" outcome for its own generator', async () => {
    recommendations = [rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' })];
    await autoRemediateSafeRecommendations(1);
    assert.deepEqual(recordedOutcomes.sort((a, b) => a.generatorId.localeCompare(b.generatorId)), [
      { generatorId: 'faq', outcome: 'shipped' },
      { generatorId: 'meta-title', outcome: 'shipped' },
    ]);
  });

  test('a genuine failure records "failed"; a principled refusal records "refused", never "failed"', async () => {
    recommendations = [rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' })];
    refuseOn = (type) => type === 'meta-title';
    generateError = () => new Error('a genuine systemic fault');
    failOn = () => true;
    // failOn alone isn't read by generateDraft's mock; force via refuseOn for
    // f1 (refusal) and a thrown non-refusal error for f2 via generateError
    // gated on attempt number instead, to get one of each deterministically.
    let attempt = 0;
    generateError = () => { attempt++; return attempt === 2 ? new Error('a genuine systemic fault') : null; };

    await autoRemediateSafeRecommendations(1);

    const byGenerator = Object.fromEntries(recordedOutcomes.map((o) => [o.generatorId, o.outcome]));
    assert.equal(byGenerator['meta-title'], 'refused');
    assert.equal(byGenerator['faq'], 'failed');
  });
});

describe('impactConfidence (measured business impact) tempers ranking within a tier, never blocks', () => {
  beforeEach(reset);

  test('same priority tier and expected impact: the generator with a stronger measured-impact history is attempted first', async () => {
    recommendations = [
      { ...rec(1, { type: 'weak-impact-history' }), priority: 'high', expected_impact: { value: 10 } },
      { ...rec(2, { type: 'strong-impact-history' }), priority: 'high', expected_impact: { value: 10 } },
    ];
    learnedMap = new Map([
      ['weak-impact-history', { confidence: 1, impactConfidence: 0.1 }],
      ['strong-impact-history', { confidence: 1, impactConfidence: 0.9 }],
    ]);

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 2, 'both still ship — impact only reorders within the tier, priority order remains the action-selection mechanism');
    assert.deepEqual(calls.generated, ['f2', 'f1']);
  });

  test('a generator with weak measured impact history still ships — impact is a ranking input, never a hard gate', async () => {
    recommendations = [rec(1, { type: 'weak-impact-history' })];
    learnedMap = new Map([['weak-impact-history', { confidence: 1, impactConfidence: 0.01 }]]);

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 1);
    assert.deepEqual(calls.generated, ['f1']);
  });

  test('no impact history yet is neutral, but a generator with a strong overall track record can still outrank it', async () => {
    recommendations = [
      { ...rec(1, { type: 'no-history' }), priority: 'high', expected_impact: { value: 10 } },
      { ...rec(2, { type: 'weak-impact-history' }), priority: 'high', expected_impact: { value: 10 } },
    ];
    // weak-impact-history has a POOR measured business impact (0.1) but a
    // PERFECT technical ship-success record (confidence: 1) — additive
    // scoring (growth-scoring.js's confidenceScore) sums both swings around
    // neutral rather than multiplying them, so its net (+15) still beats
    // no-history's flat neutral (0): a generator that reliably ships is a
    // real signal even where its measured GSC impact is still uncertain.
    learnedMap = new Map([['weak-impact-history', { confidence: 1, impactConfidence: 0.1 }]]);

    await autoRemediateSafeRecommendations(1);

    assert.deepEqual(calls.generated, ['f2', 'f1']);
  });
});
