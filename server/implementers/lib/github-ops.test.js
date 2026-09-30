import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Every GitHub call fails by default, so each entry point below takes its
// catch branch. Individual tests that need a happy path (e.g. the
// family-write marker tests) swap the relevant `defaults` entry for the
// duration of the test and restore it afterwards — node:test's mock.module
// can only mock a given specifier once per file, so per-test variation has
// to happen through this indirection rather than a second mock.module call.
const defaults = {
  getBranchSha: async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); },
  createBranch: async () => { throw new Error('Bad credentials (401)'); },
  commitFilesAtomic: async () => { throw new Error('Bad credentials (401)'); },
  createCommitObject: async () => { throw new Error('Bad credentials (401)'); },
  updateRef: async () => { throw new Error('Bad credentials (401)'); },
  openPullRequest: async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); },
  getFileContent: async () => null,
  mergeBranchFromBase: async () => ({ ok: true, conflicted: false, synced: false }),
  compareCommits: async () => ({ files: [] }),
  listOpenPullRequestsForBranch: async () => [],
  getCommitMessage: async () => { throw new Error('Bad credentials (401)'); },
};

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getBranchSha: (...a) => defaults.getBranchSha(...a),
    createBranch: (...a) => defaults.createBranch(...a),
    commitFilesAtomic: (...a) => defaults.commitFilesAtomic(...a),
    // Not exercised by any test below (none of them enter batch mode via
    // beginBatchPush) — stubs exist only so github-ops.js's imports resolve.
    createCommitObject: (...a) => defaults.createCommitObject(...a),
    updateRef: (...a) => defaults.updateRef(...a),
    getCommitMessage: (...a) => defaults.getCommitMessage(...a),
    beginFileOverlay: () => {},
    endFileOverlay: () => {},
    recordFileOverlayWrites: () => {},
    mergeBranchFromBase: (...a) => defaults.mergeBranchFromBase(...a),
    compareCommits: (...a) => defaults.compareCommits(...a),
    openPullRequest: (...a) => defaults.openPullRequest(...a),
    listOpenPullRequestsForBranch: (...a) => defaults.listOpenPullRequestsForBranch(...a),
    getPullRequest: async () => ({}),
    getCheckRunsForRef: async () => [],
    defaultBranchName: (site) => site.repo_default_branch || 'main',
    getFileContent: (...a) => defaults.getFileContent(...a),
    getRepoTree: async () => ({ files: [], truncated: false }),
    putFile: async () => ({}),
  },
});

const {
  pushDraftBranch, openPrForBranch, openRollbackPr, batchBranchName, beginBatchPush, endBatchPush,
  getOrInitBatchBranch, batchBranchConflictError,
} = await import('./github-ops.js');

const site = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
const draft = { id: 42, action_type: 'schema', branch_name: 'action-center/batch-1-2026-08-13', content: {} };

// A persisted failure has to stay diagnosable. safeMessage deliberately replaces
// the real error with fixed customer-safe wording, so without the correlation id
// travelling alongside it, drafts.apply_error says only "could not be pushed" —
// which is exactly the state four real drafts on site 1 sat in for three days.
describe('persisted GitHub failures carry a correlation ref', () => {
  const cases = [
    ['pushDraftBranch', () => pushDraftBranch(site, draft, [{ path: 'a.njk', content: 'x' }], 'main')],
    ['openPrForBranch', () => openPrForBranch(site, draft, draft.branch_name)],
    ['openRollbackPr', () => openRollbackPr(site, draft, { filePath: 'a.njk', content: 'x' })],
  ];

  for (const [name, run] of cases) {
    test(`${name} returns a ref alongside the sanitized message`, async () => {
      const result = await run();

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'github-error');
      assert.match(result.error, /\(ref: [0-9a-f]+\)$/, 'the log correlation id must survive into the persisted error');
    });

    test(`${name} still redacts the underlying error`, async () => {
      const result = await run();

      // The raw error carried a token and an HTTP status. Neither may reach a
      // string that gets stored on the draft and rendered to a customer.
      assert.doesNotMatch(result.error, /ghp_SECRET/);
      assert.doesNotMatch(result.error, /401/);
      assert.match(result.error, /our team has been notified/);
    });
  }

  test('two failures get distinct refs, so they can be told apart in the logs', async () => {
    const a = await pushDraftBranch(site, draft, [{ path: 'a.njk', content: 'x' }], 'main');
    const b = await pushDraftBranch(site, draft, [{ path: 'b.njk', content: 'y' }], 'main');
    const refOf = (s) => s.error.match(/\(ref: ([0-9a-f]+)\)/)[1];

    assert.notEqual(refOf(a), refOf(b));
  });
});

describe('family-write marker on same-day _data batches', () => {
  test('a second draft touching an already-changed _data file gets the marker', async () => {
    let captured;
    defaults.getBranchSha = async () => 'sha123';
    defaults.createBranch = async () => ({});
    defaults.commitFilesAtomic = async (site, branch, files, message) => { captured = message; return { sha: 'new' }; };
    // base branch still has the old record; today's batch branch already
    // carries an earlier draft's edit to the same shared _data file.
    defaults.getFileContent = async (site, path, ref) => (
      ref === 'main' ? { content: 'old', sha: 'a' } : { content: 'new', sha: 'b' }
    );

    try {
      const result = await pushDraftBranch(
        site, draft,
        [{ path: 'src/_data/comparisons.js', content: 'x' }],
        { branchName: 'action-center/batch-1-2026-08-16', exists: true },
      );

      assert.equal(result.ok, true);
      assert.match(captured, /\[family-write\]$/);
    } finally {
      defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
      defaults.createBranch = async () => { throw new Error('Bad credentials (401)'); };
      defaults.commitFilesAtomic = async () => { throw new Error('Bad credentials (401)'); };
      defaults.getFileContent = async () => null;
    }
  });

  test('the first draft of the day on a fresh branch gets no marker', async () => {
    let captured;
    defaults.getBranchSha = async () => 'sha123';
    defaults.createBranch = async () => ({});
    defaults.commitFilesAtomic = async (site, branch, files, message) => { captured = message; return { sha: 'new' }; };
    defaults.getFileContent = async () => { throw new Error('should not be called when target.exists is false'); };

    try {
      const result = await pushDraftBranch(
        site, draft,
        [{ path: 'src/_data/comparisons.js', content: 'x' }],
        { branchName: 'action-center/batch-1-2026-08-16', exists: false },
      );

      assert.equal(result.ok, true);
      assert.doesNotMatch(captured, /\[family-write\]/);
    } finally {
      defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
      defaults.createBranch = async () => { throw new Error('Bad credentials (401)'); };
      defaults.commitFilesAtomic = async () => { throw new Error('Bad credentials (401)'); };
      defaults.getFileContent = async () => null;
    }
  });

  test('a global-by-design draft (analytics-install) gets the marker on its own, even as the day\'s first commit', async () => {
    let captured;
    defaults.getBranchSha = async () => 'sha123';
    defaults.createBranch = async () => ({});
    defaults.commitFilesAtomic = async (site, branch, files, message) => { captured = message; return { sha: 'new' }; };
    defaults.getFileContent = async () => { throw new Error('should not be consulted — global-by-design short-circuits the _data diff check'); };

    try {
      const result = await pushDraftBranch(
        site, { ...draft, action_type: 'analytics-install' },
        [{ path: 'src/_includes/layouts/base.njk', content: 'x' }],
        { branchName: 'action-center/batch-1-2026-08-16', exists: false },
      );

      assert.equal(result.ok, true);
      assert.match(captured, /\[family-write\]$/);
    } finally {
      defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
      defaults.createBranch = async () => { throw new Error('Bad credentials (401)'); };
      defaults.commitFilesAtomic = async () => { throw new Error('Bad credentials (401)'); };
      defaults.getFileContent = async () => null;
    }
  });
});

// Regression coverage for the PR #87 incident (zunkireelabs-web,
// 2026-09-08): getOrInitBatchBranch's sync with main came back 201 (no
// reported git conflict), yet left a duplicated `title:` line in the synced
// file — invalid YAML that broke CI. A "clean" mergeBranchFromBase result
// must not be trusted blindly; getOrInitBatchBranch now scans the files the
// sync actually touched for marker corruption before reporting success.
describe('getOrInitBatchBranch — post-sync marker corruption check', () => {
  function resetDefaults() {
    defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
    defaults.mergeBranchFromBase = async () => ({ ok: true, conflicted: false, synced: false });
    defaults.compareCommits = async () => ({ files: [] });
    defaults.getFileContent = async () => null;
  }

  test('a branch that does not exist yet is reported as not existing, no sync attempted', async () => {
    defaults.getBranchSha = async () => { const e = new Error('Not Found (404)'); throw e; };
    let called = false;
    defaults.mergeBranchFromBase = async () => { called = true; return { ok: true, synced: false }; };

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.exists, false);
      assert.equal(info.conflicted, false);
      assert.equal(called, false);
    } finally {
      resetDefaults();
    }
  });

  test('a real git conflict (409) is reported conflicted, no corruption check attempted', async () => {
    defaults.getBranchSha = async () => 'batch-sha';
    defaults.mergeBranchFromBase = async () => ({ ok: false, conflicted: true });
    let compareCalled = false;
    defaults.compareCommits = async () => { compareCalled = true; return { files: [] }; };

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.conflicted, true);
      assert.equal(info.corrupted, undefined);
      assert.equal(compareCalled, false);
    } finally {
      resetDefaults();
    }
  });

  test('nothing to sync (204) is reported clean without touching compareCommits', async () => {
    defaults.getBranchSha = async () => 'batch-sha';
    defaults.mergeBranchFromBase = async () => ({ ok: true, conflicted: false, synced: false });
    let compareCalled = false;
    defaults.compareCommits = async () => { compareCalled = true; return { files: [] }; };

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.conflicted, false);
      assert.equal(compareCalled, false);
    } finally {
      resetDefaults();
    }
  });

  test('a clean (201) sync that leaves no duplicated marker is reported clean', async () => {
    defaults.getBranchSha = async () => 'before-sha';
    defaults.mergeBranchFromBase = async () => ({ ok: true, conflicted: false, synced: true, sha: 'after-sha' });
    defaults.compareCommits = async (s, base, head) => {
      assert.equal(base, 'before-sha');
      assert.equal(head, 'after-sha');
      return { files: ['src/pages/resources/ai-search-playbook.njk'] };
    };
    defaults.getFileContent = async () => ({ content: 'title: "Hello" # SEOAI:TITLE\n', sha: 'x' });

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.conflicted, false);
      assert.equal(info.corrupted, undefined);
    } finally {
      resetDefaults();
    }
  });

  test('a clean (201) sync that duplicates a LINE marker is reported conflicted+corrupted — the actual PR #87 shape', async () => {
    const path = 'src/pages/resources/ai-search-playbook.njk';
    defaults.getBranchSha = async () => 'before-sha';
    defaults.mergeBranchFromBase = async () => ({ ok: true, conflicted: false, synced: true, sha: 'after-sha' });
    defaults.compareCommits = async () => ({ files: [path, 'unrelated/page.njk'] });
    defaults.getFileContent = async (s, p) => (
      p === path
        ? { content: 'title: "A" # SEOAI:TITLE\ntitle: "B" # SEOAI:TITLE\n', sha: 'x' }
        : { content: 'title: "fine" # SEOAI:TITLE\n', sha: 'y' }
    );

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.conflicted, true);
      assert.equal(info.corrupted, true);
      assert.equal(info.corruptedFiles.length, 1);
      assert.equal(info.corruptedFiles[0].path, path);
      assert.deepEqual(info.corruptedFiles[0].markers, ['TITLE']);

      const err = batchBranchConflictError(site, info);
      assert.equal(err.ok, false);
      assert.match(err.error, new RegExp(path.replace(/\//g, '\\/')));
      assert.match(err.error, /TITLE/);
    } finally {
      resetDefaults();
    }
  });

  test('a failure inside the corruption check itself never blocks an otherwise-clean sync', async () => {
    defaults.getBranchSha = async () => 'before-sha';
    defaults.mergeBranchFromBase = async () => ({ ok: true, conflicted: false, synced: true, sha: 'after-sha' });
    defaults.compareCommits = async () => { throw new Error('transient GitHub 5xx'); };

    try {
      const info = await getOrInitBatchBranch(site);
      assert.equal(info.conflicted, false);
    } finally {
      resetDefaults();
    }
  });
});

// Regression coverage for the actual Action Center batching feature:
// up to 60 recommendations in one run used to mean up to 60 separate GitHub
// pushes (each its own Vercel preview build) AND 60 separate commits on the
// same branch/PR. beginBatchPush/endBatchPush stage every item's files/
// message in memory and build exactly ONE commit + ONE ref move at the end
// of the run.
describe('beginBatchPush / endBatchPush', () => {
  const batchBranch = 'action-center/batch-1-2026-08-30';

  function stubCommitAndRef() {
    const commits = []; // {parentSha, files, message, treeBaseSha}
    const refUpdates = []; // {branch, sha, forced}
    let nextSha = 1;
    defaults.getBranchSha = async () => 'main-tip-sha';
    defaults.createBranch = async () => ({});
    defaults.createCommitObject = async (site, parentSha, files, message, opts = {}) => {
      commits.push({ parentSha, files, message, treeBaseSha: opts.treeBaseSha });
      return `commit-sha-${nextSha++}`;
    };
    defaults.updateRef = async (site, branch, sha, opts = {}) => { refUpdates.push({ branch, sha, forced: opts.force ?? false }); };
    return { commits, refUpdates };
  }

  function resetDefaults() {
    defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
    defaults.createBranch = async () => { throw new Error('Bad credentials (401)'); };
    defaults.commitFilesAtomic = async () => { throw new Error('Bad credentials (401)'); };
    defaults.createCommitObject = async () => { throw new Error('Bad credentials (401)'); };
    defaults.updateRef = async () => { throw new Error('Bad credentials (401)'); };
    defaults.getFileContent = async () => null;
    defaults.listOpenPullRequestsForBranch = async () => [];
    defaults.getCommitMessage = async () => { throw new Error('Bad credentials (401)'); };
  }

  test('two pushes in one batch stage locally, create no commit, and move the ref exactly once at endBatchPush', async () => {
    const { commits, refUpdates } = stubCommitAndRef();
    try {
      beginBatchPush(site, batchBranch);
      const r1 = await pushDraftBranch(site, { ...draft, id: 1 }, [{ path: 'a.njk', content: 'x' }], { branchName: batchBranch, exists: true });
      const r2 = await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(refUpdates.length, 0, 'no ref move must happen until endBatchPush');
      assert.equal(commits.length, 0, 'no commit must be created until endBatchPush builds the single batch commit');

      const finalized = await endBatchPush(site, batchBranch);
      assert.deepEqual(finalized, { ok: true, pushed: 2 });
      assert.equal(commits.length, 1, 'exactly ONE commit for the whole batch');
      assert.equal(commits[0].parentSha, 'main-tip-sha', 'the single commit chains off the real branch tip');
      assert.deepEqual(commits[0].files.map((f) => f.path).sort(), ['a.njk', 'b.njk'], 'both drafts\' files land in the one commit');
      assert.match(commits[0].message, /draft #1/, 'the single commit subject still references draft #1');
      assert.match(commits[0].message, /draft #2/, 'the single commit subject still references draft #2');
      assert.doesNotMatch(commits[0].message, /\n/, 'the subject must stay one line — batch-pr-recovery matches against the first line only');
      assert.deepEqual(refUpdates, [{ branch: batchBranch, sha: 'commit-sha-1', forced: false }], 'exactly ONE ref move, pointing at the one batch commit, not forced (first commit of the day)');
    } finally {
      resetDefaults();
    }
  });

  test('endBatchPush with nothing queued is a no-op — never calls updateRef', async () => {
    const { refUpdates } = stubCommitAndRef();
    try {
      beginBatchPush(site, batchBranch);
      const finalized = await endBatchPush(site, batchBranch);
      assert.deepEqual(finalized, { ok: true, pushed: 0 });
      assert.equal(refUpdates.length, 0);
    } finally {
      resetDefaults();
    }
  });

  test('endBatchPush without a matching beginBatchPush is also a safe no-op', async () => {
    const finalized = await endBatchPush(site, 'never-begun-branch');
    assert.deepEqual(finalized, { ok: true, pushed: 0 });
  });

  test('a failed ref update surfaces as a persisted, ref-carrying failure — same shape as every other GitHub failure here', async () => {
    stubCommitAndRef();
    defaults.updateRef = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 1 }, [{ path: 'a.njk', content: 'x' }], { branchName: batchBranch, exists: true });

      const finalized = await endBatchPush(site, batchBranch);
      assert.equal(finalized.ok, false);
      assert.doesNotMatch(finalized.error, /ghp_SECRET/);
      assert.match(finalized.error, /\(ref: [0-9a-f]+\)$/);
    } finally {
      resetDefaults();
    }
  });

  test('endBatchPush clears state — a later push for the same branch is NOT deferred anymore', async () => {
    const { refUpdates } = stubCommitAndRef();
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 1 }, [{ path: 'a.njk', content: 'x' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);
      assert.equal(refUpdates.length, 1);

      // No beginBatchPush this time — pushDraftBranch must fall back to its
      // original immediate commitFilesAtomic path.
      let immediateCalled = false;
      defaults.commitFilesAtomic = async () => { immediateCalled = true; return { sha: 'x' }; };
      const result = await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'c.njk', content: 'z' }], { branchName: batchBranch, exists: true });

      assert.equal(result.ok, true);
      assert.equal(immediateCalled, true, 'must push immediately once no batch is active for this branch');
    } finally {
      resetDefaults();
    }
  });

  test('beginBatchPush is idempotent — a re-entrant call does not reset an in-progress batch', async () => {
    const { commits, refUpdates } = stubCommitAndRef();
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 1 }, [{ path: 'a.njk', content: 'x' }], { branchName: batchBranch, exists: true });
      beginBatchPush(site, batchBranch); // re-entrant — must be a no-op
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });

      const finalized = await endBatchPush(site, batchBranch);
      assert.equal(finalized.pushed, 2);
      assert.equal(commits.length, 1, 'the re-entrant begin did not split the batch into two commits');
      assert.equal(commits[0].parentSha, 'main-tip-sha', 'the re-entrant begin did not reset the base sha away from the real branch tip');
      assert.equal(refUpdates.length, 1);
    } finally {
      resetDefaults();
    }
  });
});

// The gap ACROSS separate same-day runs: beginBatchPush/endBatchPush above
// already guarantee ONE commit WITHIN a single run, but a SECOND, separate
// invocation later the same day (a different cron pass, a human's own
// "Execute Safe Fixes"/"bulk approve" click) used to stack its own commit on
// top instead of joining the day's one commit. This block covers
// endBatchPush's squash: it must still end up as exactly one commit per day.
describe('endBatchPush — same-day squash (one commit per day, across separate runs)', () => {
  const batchBranch = 'action-center/batch-1-2026-09-29';
  const BASE_TIP = 'main-base-sha'; // the site's real default-branch tip, unmoved all day
  const EARLIER_TODAY_SHA = 'earlier-today-commit-sha'; // today's FIRST run already committed and moved the branch here

  function resetDefaults() {
    defaults.getBranchSha = async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); };
    defaults.createBranch = async () => { throw new Error('Bad credentials (401)'); };
    defaults.createCommitObject = async () => { throw new Error('Bad credentials (401)'); };
    defaults.updateRef = async () => { throw new Error('Bad credentials (401)'); };
    defaults.listOpenPullRequestsForBranch = async () => [];
    defaults.getCommitMessage = async () => { throw new Error('Bad credentials (401)'); };
  }

  // branchTip: what the batch branch's own ref currently points at (as seen
  // by pushDraftBranch's first-write read, i.e. state.baseSha) — distinct
  // from BASE_TIP so the squash path's "is there anything to squash" check
  // (trueBase vs currentTipSha) has something real to compare.
  function stubSecondRun({ branchTip, openPrs = [], priorMessage = null, priorMessageOk = true }) {
    const commits = [];
    const refUpdates = [];
    let nextSha = 1;
    defaults.getBranchSha = async (site, branch) => (branch === batchBranch ? branchTip : BASE_TIP);
    defaults.createBranch = async () => ({});
    defaults.createCommitObject = async (site, parentSha, files, message, opts = {}) => {
      commits.push({ parentSha, files, message, treeBaseSha: opts.treeBaseSha });
      return `squashed-commit-sha-${nextSha++}`;
    };
    defaults.updateRef = async (site, branch, sha, opts = {}) => { refUpdates.push({ branch, sha, forced: opts.force ?? false }); };
    defaults.listOpenPullRequestsForBranch = async () => openPrs;
    defaults.getCommitMessage = async () => {
      if (!priorMessageOk) throw new Error('network error reading prior commit');
      return priorMessage;
    };
    return { commits, refUpdates };
  }

  test('a second same-day run with no PR open yet squashes into ONE commit off the real pre-today base', async () => {
    const { commits, refUpdates } = stubSecondRun({
      branchTip: EARLIER_TODAY_SHA,
      openPrs: [],
      priorMessage: 'Action Center: batch — draft #1 (schema)',
    });
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });
      const finalized = await endBatchPush(site, batchBranch);

      assert.deepEqual(finalized, { ok: true, pushed: 1 });
      assert.equal(commits.length, 1);
      assert.equal(commits[0].parentSha, BASE_TIP, 'the squashed commit\'s parent skips past today\'s earlier commit, straight to the real pre-today base');
      assert.equal(commits[0].treeBaseSha, EARLIER_TODAY_SHA, 'the tree still builds on everything already on the branch, so earlier-today\'s files are not lost');
      assert.match(commits[0].message, /draft #1 \(schema\)/, 'the earlier run\'s real entry is preserved, not discarded');
      assert.match(commits[0].message, /draft #2/, 'this run\'s new entry is included too');
      assert.deepEqual(refUpdates, [{ branch: batchBranch, sha: 'squashed-commit-sha-1', forced: true }], 'a non-fast-forward update is required since the new commit is not a descendant of the one it replaces');
    } finally {
      resetDefaults();
    }
  });

  test('a PR already open for the branch: never squashes, stacks normally instead', async () => {
    const { commits, refUpdates } = stubSecondRun({
      branchTip: EARLIER_TODAY_SHA,
      openPrs: [{ number: 42 }],
      priorMessage: 'Action Center: batch — draft #1 (schema)',
    });
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);

      assert.equal(commits[0].parentSha, EARLIER_TODAY_SHA, 'stacks on top of the existing commit — never rewrites a commit a human may already be reviewing');
      assert.equal(refUpdates[0].forced, false, 'an ordinary fast-forward update, not a rewrite');
      assert.doesNotMatch(commits[0].message, /draft #1/, 'a normal stacked commit carries only THIS run\'s entries, same as before this feature existed');
    } finally {
      resetDefaults();
    }
  });

  test('could not determine whether a PR is open: refuses to guess, stacks normally', async () => {
    const { commits } = stubSecondRun({ branchTip: EARLIER_TODAY_SHA, priorMessage: 'Action Center: batch — draft #1' });
    defaults.listOpenPullRequestsForBranch = async () => { throw new Error('GitHub API unreachable'); };
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);

      assert.equal(commits[0].parentSha, EARLIER_TODAY_SHA, 'unknown PR status is treated the same as "a PR might be open" — never squash on a guess');
    } finally {
      resetDefaults();
    }
  });

  test('the existing tip commit is not one of ours (no recognizable prefix): refuses to guess, stacks normally', async () => {
    const { commits } = stubSecondRun({
      branchTip: EARLIER_TODAY_SHA, openPrs: [],
      priorMessage: 'Manual hotfix pushed directly by a human',
    });
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);

      assert.equal(commits[0].parentSha, EARLIER_TODAY_SHA, 'never absorbs or discards a commit this app did not write itself');
    } finally {
      resetDefaults();
    }
  });

  test('could not read the prior commit\'s message at all: refuses to guess, stacks normally', async () => {
    const { commits } = stubSecondRun({ branchTip: EARLIER_TODAY_SHA, openPrs: [], priorMessageOk: false });
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 2 }, [{ path: 'b.njk', content: 'y' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);

      assert.equal(commits[0].parentSha, EARLIER_TODAY_SHA);
    } finally {
      resetDefaults();
    }
  });

  test('the branch tip already equals the real base (first commit of the day): no squash logic even attempted', async () => {
    const { commits } = stubSecondRun({ branchTip: BASE_TIP, openPrs: [] });
    let prCheckCalled = false;
    defaults.listOpenPullRequestsForBranch = async () => { prCheckCalled = true; return []; };
    try {
      beginBatchPush(site, batchBranch);
      await pushDraftBranch(site, { ...draft, id: 1 }, [{ path: 'a.njk', content: 'x' }], { branchName: batchBranch, exists: true });
      await endBatchPush(site, batchBranch);

      assert.equal(commits[0].parentSha, BASE_TIP);
      assert.equal(prCheckCalled, false, 'nothing to squash — never even asks whether a PR is open');
    } finally {
      resetDefaults();
    }
  });
});

describe('batchBranchName', () => {
  test('is keyed per site and per day, so one tenant-day means one branch', () => {
    const d = new Date('2026-08-13T09:00:00Z');
    assert.equal(batchBranchName({ id: 1 }, d), 'action-center/batch-1-2026-08-13');
    assert.equal(batchBranchName({ id: 7 }, d), 'action-center/batch-7-2026-08-13');
  });

  test('rolls to a new branch on the next day', () => {
    assert.notEqual(
      batchBranchName({ id: 1 }, new Date('2026-08-13T23:59:00Z')),
      batchBranchName({ id: 1 }, new Date('2026-08-14T00:01:00Z')),
    );
  });

  // The whole point of using the site's own timezone: the morning run and the
  // catch-up guard a few hours later are the SAME local day and the same
  // budget day, so they must land on the same branch and therefore the same
  // PR. Under the previous UTC slice these two instants produced different
  // names and a second PR for one day's work.
  test('a site-local day is one branch even when it straddles UTC midnight', () => {
    const site = { id: 1, timezone: 'Asia/Kolkata' };
    const morningRun = new Date('2026-08-13T01:30:00Z');   // 07:00 IST, 13 Aug
    const catchupRun = new Date('2026-08-13T05:35:00Z');   // 11:05 IST, still 13 Aug
    assert.equal(batchBranchName(site, morningRun), 'action-center/batch-1-2026-08-13');
    assert.equal(batchBranchName(site, catchupRun), batchBranchName(site, morningRun));
  });

  test('rolls over on the SITE local day boundary, not the UTC one', () => {
    const site = { id: 1, timezone: 'Asia/Kolkata' };
    // 2026-08-13T19:00Z is already 14 Aug 00:30 IST — a new local day.
    assert.equal(batchBranchName(site, new Date('2026-08-13T19:00:00Z')), 'action-center/batch-1-2026-08-14');
    // ...while 18:00Z is still 23:30 IST on the 13th.
    assert.equal(batchBranchName(site, new Date('2026-08-13T18:00:00Z')), 'action-center/batch-1-2026-08-13');
  });

  test('falls back to UTC for a site with no timezone set', () => {
    assert.equal(batchBranchName({ id: 3 }, new Date('2026-08-13T23:00:00Z')), 'action-center/batch-3-2026-08-13');
  });
});
