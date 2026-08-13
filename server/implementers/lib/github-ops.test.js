import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Every GitHub call fails, so each entry point below takes its catch branch.
mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getBranchSha: async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); },
    createBranch: async () => { throw new Error('Bad credentials (401)'); },
    commitFilesAtomic: async () => { throw new Error('Bad credentials (401)'); },
    mergeBranchFromBase: async () => ({ ok: true }),
    openPullRequest: async () => { throw new Error('Bad credentials (401) token=ghp_SECRET'); },
    listOpenPullRequestsForBranch: async () => [],
    getPullRequest: async () => ({}),
    getCheckRunsForRef: async () => [],
    defaultBranchName: (site) => site.repo_default_branch || 'main',
    getFileContent: async () => null,
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
