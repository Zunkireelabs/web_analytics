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
  openPullRequest: async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); },
  getFileContent: async () => null,
};

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getBranchSha: (...a) => defaults.getBranchSha(...a),
    createBranch: (...a) => defaults.createBranch(...a),
    commitFilesAtomic: (...a) => defaults.commitFilesAtomic(...a),
    mergeBranchFromBase: async () => ({ ok: true }),
    openPullRequest: (...a) => defaults.openPullRequest(...a),
    listOpenPullRequestsForBranch: async () => [],
    getPullRequest: async () => ({}),
    getCheckRunsForRef: async () => [],
    defaultBranchName: (site) => site.repo_default_branch || 'main',
    getFileContent: (...a) => defaults.getFileContent(...a),
    getRepoTree: async () => ({ files: [], truncated: false }),
    putFile: async () => ({}),
  },
});

const { pushDraftBranch, openPrForBranch, openRollbackPr, batchBranchName } = await import('./github-ops.js');

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
});

describe('batchBranchName', () => {
  test('is keyed per site and per UTC day, so one tenant-day means one branch', () => {
    const d = new Date('2026-08-13T09:00:00Z');
    assert.equal(batchBranchName({ id: 1 }, d), 'action-center/batch-1-2026-08-13');
    assert.equal(batchBranchName({ id: 7 }, d), 'action-center/batch-7-2026-08-13');
  });

  test('rolls to a new branch on the next UTC day', () => {
    assert.notEqual(
      batchBranchName({ id: 1 }, new Date('2026-08-13T23:59:00Z')),
      batchBranchName({ id: 1 }, new Date('2026-08-14T00:01:00Z')),
    );
  });
});
