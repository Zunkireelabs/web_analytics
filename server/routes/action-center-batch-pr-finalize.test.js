import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeBatchPr } from './action-center.js';

// finalizeBatchPr's own contract: what happens when real commits land on a
// batch branch with NO `drafts` table row behind any of them — the shape a
// content-repair-only shipping run produces (its file edits are pushed
// straight onto the batch branch, never through generateDraft/the drafts
// table at all — see store/shipping-queue.js and the queue-drain step in
// auto-remediation.js).
//
// Driven entirely through finalizeBatchPr's own injectable deps
// (dpEndBatchPush/dpOpenDraftPr/dpMarkDraftPrOpened/dpOpenPrForBranch)
// rather than module-mocking action-center.js's own imports — mock.module on
// any of this file's neighbors breaks module resolution for its much larger
// import graph under --experimental-test-module-mocks (the documented
// openai/formdata-node instantiation failure other test files in this repo
// route around the same way).

const SITE = { id: 1, repo_owner: 'acme', repo_name: 'x' };
const BRANCH = 'action-center/batch-2026-09-08';

let openDraftPrCalls;
let markDraftPrOpenedCalls;
let openPrForBranchCalls;
let openPrForBranchResult;
let endBatchPushResult;

beforeEach(() => {
  openDraftPrCalls = [];
  markDraftPrOpenedCalls = [];
  openPrForBranchCalls = [];
  openPrForBranchResult = { ok: true, prUrl: 'https://github.com/acme/x/pull/9', prNumber: 9, reused: false };
  endBatchPushResult = { ok: true, pushed: 0 };
});

const deps = () => ({
  dpEndBatchPush: async () => endBatchPushResult,
  dpOpenDraftPr: async (...a) => { openDraftPrCalls.push(a); return { pr_number: 5, pr_url: 'https://github.com/acme/x/pull/5' }; },
  dpMarkDraftPrOpened: async (...a) => { markDraftPrOpenedCalls.push(a); },
  dpOpenPrForBranch: async (...a) => { openPrForBranchCalls.push(a); return openPrForBranchResult; },
});

describe('finalizeBatchPr — draft-backed items (existing behavior, unchanged)', () => {
  test('opens via the first draft and marks the rest pr_opened', async () => {
    endBatchPushResult = { ok: true, pushed: 3 };
    const result = await finalizeBatchPr(SITE, BRANCH, [101, 102, 103], deps());
    assert.equal(result.ok, true);
    assert.equal(result.prUrl, 'https://github.com/acme/x/pull/5');
    assert.equal(openDraftPrCalls.length, 1);
    assert.deepEqual(openDraftPrCalls[0], [SITE.id, 101]);
    assert.equal(markDraftPrOpenedCalls.length, 2, 'the other two drafts are marked pr_opened, not re-opened');
    assert.equal(openPrForBranchCalls.length, 0, 'never takes the no-draft path when draftIds is non-empty');
  });
});

describe('finalizeBatchPr — no draft-backed items still opens a PR when real commits pushed', () => {
  test('pushed > 0 with an EMPTY draftIds list opens a PR via openPrForBranch, not silently prUrl:null', async () => {
    endBatchPushResult = { ok: true, pushed: 2 };
    const result = await finalizeBatchPr(SITE, BRANCH, [], deps());

    assert.equal(result.ok, true);
    assert.equal(result.pushed, 2);
    assert.equal(result.prUrl, 'https://github.com/acme/x/pull/9', 'a real pushed branch must never come back with prUrl: null — that is the exact stranded-batch shape batch-pr-recovery.js exists to recover');
    assert.equal(result.prNumber, 9);
    assert.equal(openPrForBranchCalls.length, 1);
    assert.equal(openDraftPrCalls.length, 0);
  });

  test('nothing pushed and an empty draftIds list opens no PR at all', async () => {
    const result = await finalizeBatchPr(SITE, BRANCH, [], deps());
    assert.equal(result.ok, true);
    assert.equal(result.pushed, 0);
    assert.equal(result.prUrl, null);
    assert.equal(openPrForBranchCalls.length, 0, 'no real commit landed — nothing to open a PR for');
  });

  test('openPrForBranch failing surfaces as a real finalize failure, same shape as openDraftPr failing', async () => {
    endBatchPushResult = { ok: true, pushed: 2 };
    openPrForBranchResult = { ok: false, error: 'GitHub API rate limited', rateLimited: true };
    const result = await finalizeBatchPr(SITE, BRANCH, [], deps());
    assert.equal(result.ok, false);
    assert.equal(result.rateLimited, true);
  });

  test('an already-open PR on the branch is reused, not duplicated (openPrForBranch\'s own contract, surfaced through)', async () => {
    endBatchPushResult = { ok: true, pushed: 1 };
    openPrForBranchResult = { ok: true, prUrl: 'https://github.com/acme/x/pull/7', prNumber: 7, reused: true };
    const result = await finalizeBatchPr(SITE, BRANCH, [], deps());
    assert.equal(result.prUrl, 'https://github.com/acme/x/pull/7');
    assert.equal(result.prNumber, 7);
  });

  test('endBatchPush itself failing never reaches openPrForBranch', async () => {
    endBatchPushResult = { ok: false, error: 'push failed', rateLimited: false };
    const result = await finalizeBatchPr(SITE, BRANCH, [], deps());
    assert.equal(result.ok, false);
    assert.equal(openPrForBranchCalls.length, 0);
  });
});
