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
let pendingDraftFilePaths;
let site;
let spentToday;
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

function reset() {
  site = { id: 1, timezone: 'Asia/Kolkata', auto_remediation_enabled: true, auto_remediation_daily_limit: 30 };
  onboardingPending = false; // matches every existing test's assumption: analysis already done, repair may proceed
  recommendations = [];
  draftedFindingIds = new Set();
  pendingDraftFilePaths = new Set();
  spentToday = 0;
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
    // resume a draft stranded at 'approved' by a failed apply().
    pushDraftBranch: async (siteId, draftId) => {
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
      if (finalizeBatchFails) return { ok: false, error: 'simulated batch push/PR failure', rateLimited: finalizeBatchRateLimited };
      calls.prsOpened.push(...draftIds);
      return { ok: true, pushed: draftIds.length, prNumber: 1, prUrl: 'https://github.com/acme/site/pull/1' };
    },
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
});

// Categories come from recommendation-taxonomy.js's classify() — the same
// grouping the Action Center UI shows (e.g. "Meta Titles", "Broken Links",
// "Blog Opportunities"). Without a per-category cap, a category with sheer
// volume (e.g. 139 open GEO Signals items) would consume the entire day's
// budget and a category with only 1-3 open items would never ship at all.
describe('auto-remediation — category-diverse selection', () => {
  beforeEach(reset);

  test('no single category takes more than 5 of the day\'s budget while other categories still have candidates', async () => {
    site.auto_remediation_daily_limit = 8;
    recommendations = [
      // detectingAgents matters here — 'opportunity' (rec()'s default) hits
      // recommendation-taxonomy.js's source-level wildcard and collapses
      // everything into one category regardless of type, so each generator
      // here is paired with the real agent that actually detects it.
      ...Array.from({ length: 10 }, (_, i) => rec(i + 1, { type: 'meta-title', detectingAgents: ['content-gap'] })), // -> "Meta Titles"
      rec(11, { type: 'broken-link-fix', detectingAgents: ['technical-seo'] }), // -> "Broken Links"
      rec(12, { type: 'broken-link-fix', detectingAgents: ['technical-seo'] }),
      rec(13, { type: 'faq', detectingAgents: ['content-gap'] }), // -> "FAQ Opportunities"
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 8, 'the full 8-item budget is used even though one category alone had 10 candidates');
    const metaTitleShipped = calls.generated.filter((f) => ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'].includes(f));
    assert.equal(metaTitleShipped.length, 5, 'Meta Titles is capped at 5 even though 3 budget slots remained');
    assert.deepEqual(calls.generated.filter((f) => f === 'f11' || f === 'f12'), ['f11', 'f12'], 'both Broken Links candidates ship — the smaller category is not crowded out');
    assert.ok(calls.generated.includes('f13'), 'the single Blog Opportunities candidate ships too');
  });

  test('budget left over after every category\'s 5-item cap is topped up from the next-highest-priority leftovers', async () => {
    site.auto_remediation_daily_limit = 8;
    recommendations = [
      ...Array.from({ length: 10 }, (_, i) => rec(i + 1, { type: 'meta-title', detectingAgents: ['content-gap'] })),
      rec(11, { type: 'broken-link-fix', detectingAgents: ['technical-seo'] }),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 8, 'only one other category exists, so the top-up pass fills the rest of the budget from the capped category');
    assert.ok(calls.generated.includes('f11'), 'the other category still ships');
  });
});

describe('auto-remediation — circuit breaker', () => {
  beforeEach(reset);

  test('five consecutive failures stop the run early, leaving the rest untouched and open', async () => {
    recommendations = [
      rec(1, { type: 'bad' }), rec(2, { type: 'bad' }), rec(3, { type: 'bad' }),
      rec(4, { type: 'bad' }), rec(5, { type: 'bad' }), rec(6), rec(7),
    ];
    failOn = (type) => type === 'bad';

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 5);
    assert.equal(result.shipped, 0);
    assert.equal(result.stoppedReason, 'circuit-breaker');
    assert.equal(result.attempted, 5, 'must not keep trying past the breaker');
    assert.equal(calls.generated.length, 0, 'none of the five succeeded');
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

  test('when the batch push/PR itself fails, every pending item reverts to failed and gets abandoned', async () => {
    finalizeBatchFails = true;
    recommendations = [rec(1), rec(2)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.shipped, 0, 'nothing actually reached GitHub');
    assert.equal(result.failed, 2);
    assert.deepEqual(calls.prsOpened, [], 'no PR was opened');
    assert.deepEqual(calls.abandoned.map((a) => a.draftId).sort(), ['d-f1', 'd-f2'], 'both drafts are abandoned so they are re-attempted on a future run, not silently stuck at branch_pushed');
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

  // The counterpart: transience must be established from evidence, not
  // assumed. A genuine fault still ends in abandonment, or a broken repo
  // would retry the same doomed work forever.
  test('a non-transient batch failure still abandons, so a real fault is never retried forever', async () => {
    finalizeBatchFails = true;
    finalizeBatchRateLimited = false;
    recommendations = [rec(1)];
    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.failed, 1);
    assert.deepEqual(calls.retryable, []);
    assert.deepEqual(calls.abandoned.map((a) => a.draftId), ['d-f1']);
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

  test('five REAL faults in a row still trip the breaker', async () => {
    failOn = (type) => type === 'schema';
    recommendations = [
      rec(1, { type: 'schema' }), rec(2, { type: 'schema' }), rec(3, { type: 'schema' }),
      rec(4, { type: 'schema' }), rec(5, { type: 'schema' }), rec(6), rec(7),
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

  test('an apply failure with no recognized message shape is still a genuine failure and trips the breaker', async () => {
    applyFailureMessageOn = (type) => type === 'qa-content' ? 'upstream GitHub API returned 503' : null;
    recommendations = [
      rec(1, { type: 'qa-content' }), rec(2, { type: 'qa-content' }), rec(3, { type: 'qa-content' }),
      rec(4, { type: 'qa-content' }), rec(5, { type: 'qa-content' }), rec(6),
    ];

    const result = await autoRemediateSafeRecommendations(1);

    assert.equal(result.stoppedReason, 'circuit-breaker', 'an unrecognized apply failure must still be treated as a possible systemic fault');
    assert.equal(result.refused, 0);
    assert.equal(result.attempted, 5);
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

  test('a genuine 5xx with no refusal flag still trips the breaker', async () => {
    // The other direction: an unflagged server error is exactly what the
    // breaker is for, and must keep tripping at CONSECUTIVE_FAILURE_LIMIT.
    generateError = () => Object.assign(new Error('upstream exploded'), { status: 500 });
    recommendations = [1, 2, 3, 4, 5, 6, 7].map((i) => rec(i));

    const result = await autoRemediateSafeRecommendations(1);
    assert.equal(result.stoppedReason, 'circuit-breaker');
    assert.equal(result.attempted, 5);
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

  test('no impact history yet is treated as neutral (0.5), same convention as no technical confidence history', async () => {
    recommendations = [
      { ...rec(1, { type: 'no-history' }), priority: 'high', expected_impact: { value: 10 } },
      { ...rec(2, { type: 'weak-impact-history' }), priority: 'high', expected_impact: { value: 10 } },
    ];
    learnedMap = new Map([['weak-impact-history', { confidence: 1, impactConfidence: 0.1 }]]);

    await autoRemediateSafeRecommendations(1);

    // no-history's neutral 0.5 outranks weak-impact-history's real, worse 0.1.
    assert.deepEqual(calls.generated, ['f1', 'f2']);
  });
});
