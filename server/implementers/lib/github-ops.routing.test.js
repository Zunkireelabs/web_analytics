import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where a client's batch pull request goes: main or stage (lib/pr-routing.js), and what happens when the day's batch changes class
// after the PR was already opened. GitHub's real list-pulls shape is used for the fakes: each PR carries { number, html_url, base: { ref } }.
const here = dirname(fileURLToPath(import.meta.url));
const resolve = (rel) => resolvePath(here, rel);

const calls = { opened: [], retargeted: [], baseRecorded: [] };
let existing = [];
let batchTypes = [];

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getBranchSha: async () => 'sha', createBranch: async () => ({}), commitFilesAtomic: async () => ({}), createCommitObject: async () => ({}),
    updateRef: async () => ({}), getCommitMessage: async () => '', beginFileOverlay: () => {}, endFileOverlay: () => {}, recordFileOverlayWrites: () => {},
    mergeBranchFromBase: async () => ({ ok: true }), compareCommits: async () => ({ files: [] }),
    openPullRequest: async (_site, args) => { calls.opened.push(args); return { number: 77, url: 'https://github.com/acme/site/pull/77' }; },
    retargetPullRequest: async (_site, number, base) => { calls.retargeted.push({ number, base }); return { number, base }; },
    listOpenPullRequestsForBranch: async () => existing,
    getPullRequest: async () => ({}), getCheckRunsForRef: async () => [],
    defaultBranchName: (site) => site.repo_default_branch || 'main',
    prTargetBranchName: (site) => site.pr_target_branch || site.repo_default_branch || 'main',
    getFileContent: async () => null, getRepoTree: async () => ({ files: [], truncated: false }), putFile: async () => ({}),
  },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: {
    listBatchActionTypes: async () => batchTypes,
    setBatchPrBase: async (siteId, branch, base) => { calls.baseRecorded.push({ siteId, branch, base }); return 1; },
  },
});

const { openPrForBranch } = await import('./github-ops.js');
const BRANCH = 'action-center/batch-1-2026-11-06';
const draft = (type) => ({ id: 9, action_type: type, branch_name: BRANCH });
const siteNoStage = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
const siteStage = { ...siteNoStage, pr_target_branch: 'stage' };
const pr = (base) => ({ number: 12, html_url: 'https://github.com/acme/site/pull/12', base: { ref: base } });

describe('openPrForBranch routing', () => {
  beforeEach(() => { calls.opened = []; calls.retargeted = []; calls.baseRecorded = []; existing = []; batchTypes = []; });

  test('no stage branch: always main, even for a landing page', async () => {
    const out = await openPrForBranch(siteNoStage, draft('landing-page'), BRANCH);
    assert.equal(out.ok, true);
    assert.equal(calls.opened[0].base, 'main');
    assert.equal(out.base, 'main');
  });

  test('stage branch + light content only: straight to main', async () => {
    batchTypes = ['refresh-content', 'expand-content'];
    const out = await openPrForBranch(siteStage, draft('refresh-content'), BRANCH);
    assert.equal(calls.opened[0].base, 'main');
    assert.equal(out.base, 'main');
    assert.doesNotMatch(calls.opened[0].body, /promotes/);
    assert.deepEqual(calls.baseRecorded, [{ siteId: 1, branch: BRANCH, base: 'main' }]);
  });

  test('stage branch + a landing page: the PR opens into stage and says what happens after the merge', async () => {
    batchTypes = ['refresh-content'];
    const out = await openPrForBranch(siteStage, draft('landing-page'), BRANCH);
    assert.equal(calls.opened[0].base, 'stage');
    assert.equal(out.base, 'stage');
    assert.match(calls.opened[0].body, /promotes `stage` into `main`/);
    assert.deepEqual(calls.baseRecorded, [{ siteId: 1, branch: BRANCH, base: 'stage' }]);
  });

  test('a mixed day (light edits + a template fix) is ONE PR into stage', async () => {
    batchTypes = ['refresh-content', 'schema-repair'];
    await openPrForBranch(siteStage, draft('refresh-content'), BRANCH);
    assert.equal(calls.opened.length, 1);
    assert.equal(calls.opened[0].base, 'stage');
  });

  test('a day that began as light edits (PR into main) is retargeted to stage when a heavier draft joins', async () => {
    existing = [pr('main')];
    batchTypes = ['refresh-content'];
    const out = await openPrForBranch(siteStage, draft('schema-repair'), BRANCH);
    assert.equal(out.reused, true);
    assert.equal(out.retargeted, true);
    assert.deepEqual(calls.retargeted, [{ number: 12, base: 'stage' }]);
    assert.equal(calls.opened.length, 0, 'the same PR is reused, never a second one');
    assert.deepEqual(calls.baseRecorded, [{ siteId: 1, branch: BRANCH, base: 'stage' }]);
  });

  test('a PR already on stage is reused untouched', async () => {
    existing = [pr('stage')];
    const out = await openPrForBranch(siteStage, draft('landing-page'), BRANCH);
    assert.equal(out.reused, true);
    assert.equal(out.retargeted, false);
    assert.equal(calls.retargeted.length, 0);
  });

  test('a light-only day whose PR already targets main is left alone', async () => {
    existing = [pr('main')];
    batchTypes = ['refresh-content'];
    const out = await openPrForBranch(siteStage, draft('expand-content'), BRANCH);
    assert.equal(out.retargeted, false);
    assert.equal(calls.retargeted.length, 0);
  });
});
