import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The one distinction this whole module exists to draw: a batch whose PUSH
// failed (commits never reached GitHub — regenerate) vs. one whose PR call
// failed (commits are on the branch — open one PR). Both leave every draft at
// 'branch_pushed' with an apply_error, so no test here may let the code reach
// its answer by reading that error string; the evidence has to come from what
// GitHub says is on the branch.

let draftRows = [];
let commitSubjects = [];   // null = branch gone (404)
let compareSequence = null; // optional queue of results, one per call, overrides commitSubjects while non-empty
let openPrs = [];
let compareThrows = null;
let budgetLow = false;
let openPrThrows = null;
let calls;

const resolve = (p) => new URL(p, import.meta.url).href;

mock.module(resolve('../db.js'), {
  namedExports: { query: async () => ({ rows: draftRows }) },
});
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => ({ id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' }) },
});
mock.module(resolve('../store/drafts.js'), {
  namedExports: {
    markDraftAbandoned: async (siteId, id, reason) => { calls.abandoned.push({ id, reason }); return { id }; },
    markDraftPrOpened: async (siteId, id, opts) => { calls.prOpened.push({ id, ...opts }); return { id }; },
    clearApplyErrorForPushedDraft: async (siteId, id) => { calls.cleared.push(id); return { id }; },
  },
});
mock.module(resolve('../store/recommendation-attempts.js'), {
  namedExports: { recordAttempt: async (siteId, a) => { calls.attempts.push(a); } },
});
mock.module(resolve('../github/client.js'), {
  namedExports: {
    listCommitSubjectsAheadOfBase: async () => {
      if (compareThrows) throw compareThrows;
      if (compareSequence && compareSequence.length) return compareSequence.shift();
      return commitSubjects;
    },
    listOpenPullRequestsForBranch: async () => openPrs,
    getLastKnownRateLimit: () => ({ low: budgetLow, remaining: budgetLow ? 5 : 4000, reset: null, at: null }),
  },
});

const { recoverUnopenedBatchPrs } = await import('./batch-pr-recovery.js');

const openPr = async (siteId, draftId) => {
  calls.openedFor.push(draftId);
  if (openPrThrows) throw openPrThrows;
  return { pr_number: 77, pr_url: 'https://github.com/acme/site/pull/77' };
};

const run = (opts = {}) => recoverUnopenedBatchPrs(1, { apply: true, log: null, openPr, ...opts });

beforeEach(() => {
  calls = { abandoned: [], prOpened: [], cleared: [], attempts: [], openedFor: [] };
  compareThrows = null;
  compareSequence = null;
  openPrThrows = null;
  budgetLow = false;
  openPrs = [];
  draftRows = [
    { id: 101, finding_id: 'f1', branch_name: 'action-center/batch-1-2026-09-08', action_type: 'qa-content' },
    { id: 102, finding_id: 'f2', branch_name: 'action-center/batch-1-2026-09-08', action_type: 'expand-content' },
  ];
  commitSubjects = [
    'Action Center: apply qa-content draft #101',
    'Action Center: apply expand-content draft #102',
  ];
});

describe('recoverUnopenedBatchPrs', () => {
  // The live 2026-09-08 case: 21 drafts, real commits on the branch, no PR.
  test('opens ONE PR for a branch whose commits landed, and attaches every other draft to it', async () => {
    const result = await run();
    assert.deepEqual(calls.openedFor, [101], 'exactly one PR call for the whole branch');
    assert.deepEqual(calls.prOpened.map((c) => c.id), [102], 'the rest are attached, not re-opened');
    assert.equal(calls.prOpened[0].prNumber, 77);
    assert.equal(result.opened, 2);
    assert.equal(calls.abandoned.length, 0, 'pushed work is never thrown away');
  });

  // Without this, draftShipState keeps reading these rows as never-pushed and
  // the next run regenerates them — the actual repeat loop.
  test("clears the stale PR-stage apply_error once the commits are confirmed", async () => {
    await run();
    assert.deepEqual(calls.cleared.sort(), [101, 102]);
  });

  test('clears it even when the PR still cannot be opened, so the row stays accurate and recoverable', async () => {
    openPrThrows = Object.assign(new Error('rate limited'), { rateLimited: true });
    const result = await run();
    assert.deepEqual(calls.cleared.sort(), [101, 102]);
    assert.equal(result.opened, 0);
    assert.equal(result.skipped, 2);
    assert.equal(calls.abandoned.length, 0, 'a still-throttled run must not destroy pushed work');
  });

  // The honest half. Reporting this draft against the PR would claim work
  // shipped that is not in the diff.
  test('a draft whose commit is NOT on the branch is abandoned, never swept into the PR', async () => {
    commitSubjects = ['Action Center: apply qa-content draft #101'];
    const result = await run();
    assert.deepEqual(calls.openedFor, [101]);
    assert.deepEqual(calls.abandoned.map((a) => a.id), [102]);
    assert.equal(calls.prOpened.length, 0);
    assert.equal(result.abandoned, 1);
    assert.deepEqual(calls.cleared, [101], 'only the confirmed commit gets its error cleared');
  });

  // The live 2026-09-18 case: site 1's branch had 11 real commits (confirmed
  // directly against GitHub afterward), but the FIRST compare read came back
  // empty for all of them, and every draft was abandoned on that single read.
  // A rechecked "missing" must be given one more read before being trusted —
  // this locks that in: first read says gone, second (recheck) says present,
  // the draft must land, not abandon.
  test('a commit missing on the first read but present on a recheck is treated as landed, not abandoned', async () => {
    compareSequence = [
      [], // first read: neither commit visible yet
      [   // recheck: both actually there
        'Action Center: apply qa-content draft #101',
        'Action Center: apply expand-content draft #102',
      ],
    ];
    const result = await run();
    assert.equal(calls.abandoned.length, 0, 'a transient false negative must not throw away real work');
    assert.equal(result.opened + result.adopted, 2);
  });

  // A commit still missing on the recheck too is the real thing this file
  // exists to catch — the second read must not soften that into a pass.
  test('a commit missing on both the first read and the recheck is still abandoned', async () => {
    compareSequence = [
      ['Action Center: apply qa-content draft #101'],
      ['Action Center: apply qa-content draft #101'],
    ];
    const result = await run();
    assert.deepEqual(calls.abandoned.map((a) => a.id), [102]);
    assert.equal(result.abandoned, 1);
  });

  // #10 must not satisfy a search for draft #1.
  test('commit attribution does not match a draft id by prefix', async () => {
    draftRows = [{ id: 10, finding_id: 'f1', branch_name: 'b', action_type: 'faq' }];
    commitSubjects = ['Action Center: apply faq draft #101'];
    const result = await run();
    assert.equal(result.abandoned, 1);
    assert.equal(result.opened, 0);
  });

  test('adopts an already-open PR instead of trying to open a second one for the same head', async () => {
    openPrs = [{ number: 42, html_url: 'https://github.com/acme/site/pull/42' }];
    const result = await run();
    assert.deepEqual(calls.openedFor, [], 'no PR call at all — GitHub would 422 on a duplicate head');
    assert.equal(result.adopted, 2);
    assert.deepEqual(calls.prOpened.map((c) => c.prNumber), [42, 42]);
  });

  test('a branch that no longer exists is left to the stall reclaim, not decided here', async () => {
    commitSubjects = null;
    const result = await run();
    assert.equal(result.skipped, 2);
    assert.equal(calls.abandoned.length, 0, 'pass 2 owns that decision — deciding it twice is what this file avoids');
    assert.equal(calls.openedFor.length, 0);
  });

  test('a transient GitHub failure changes nothing and waits for the next run', async () => {
    compareThrows = new Error('502 bad gateway');
    const result = await run();
    assert.equal(result.skipped, 2);
    assert.deepEqual(calls.abandoned, []);
    assert.deepEqual(calls.cleared, []);
  });

  test('dry run writes nothing anywhere', async () => {
    const result = await run({ apply: false });
    assert.deepEqual(calls, { abandoned: [], prOpened: [], cleared: [], attempts: [], openedFor: [] });
    assert.equal(result.opened, 2, 'but still reports what it would finish');
  });

  test('groups by branch so two stalled days each get their own single PR', async () => {
    draftRows = [
      { id: 101, finding_id: 'f1', branch_name: 'batch-2026-09-07', action_type: 'qa-content' },
      { id: 102, finding_id: 'f2', branch_name: 'batch-2026-09-08', action_type: 'qa-content' },
    ];
    commitSubjects = [
      'Action Center: apply qa-content draft #101',
      'Action Center: apply qa-content draft #102',
    ];
    const result = await run();
    assert.equal(result.branches, 2);
    assert.deepEqual(calls.openedFor, [101, 102], 'one PR per branch — a prior day is recoverable too');
  });

  test('refuses to run at all while the credential budget is low', async () => {
    budgetLow = true;
    const result = await run();
    assert.equal(result.skipped, 2);
    assert.equal(calls.openedFor.length, 0, 'this pass exists because a rate limit broke the batch — it must not add to one');
  });
});
