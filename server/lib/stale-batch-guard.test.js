import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const { assessBranch, describeAssessment, checkOpenBatchBranches, staleBatchMode } = await import('./stale-batch-guard.js');

describe('assessBranch', () => {
  test('a branch that is not behind is current, whatever it changed', () => {
    assert.deepEqual(assessBranch({ behindBy: 0, aheadBy: 3, headFiles: ['a'], baseFiles: [] }), { state: 'current', behindBy: 0, overlap: [] });
  });
  test('behind, and main changed files the branch also changes: the overlap is named (the revert risk)', () => {
    const a = assessBranch({ behindBy: 16, headFiles: ['public/sitemap.xml', 'CLAUDE.md'], baseFiles: ['public/sitemap.xml', 'src/app/page.tsx'] });
    assert.equal(a.state, 'behind-overlap');
    assert.deepEqual(a.overlap, ['public/sitemap.xml']);
  });
  test('behind with no shared file is "behind", a plain sync is safe', () => {
    assert.equal(assessBranch({ behindBy: 2, headFiles: ['a.md'], baseFiles: ['b.md'] }).state, 'behind');
  });
  test('a truncated file list cannot prove "no overlap", so it is treated as overlap', () => {
    const a = assessBranch({ behindBy: 2, headFiles: ['a.md'], baseFiles: ['b.md'], truncated: true });
    assert.equal(a.state, 'behind-overlap');
    assert.match(describeAssessment('action-center/batch-1-x', 7, a, 'main'), /too many files to rule out an overlap/);
  });
  test('the wording names the branch, the PR, the count and the files', () => {
    const a = assessBranch({ behindBy: 1, headFiles: ['f.xml'], baseFiles: ['f.xml'] });
    const m = describeAssessment('action-center/batch-8862-2026-11-21', 119, a, 'main');
    assert.match(m, /PR #119/); assert.match(m, /1 commit behind main/); assert.match(m, /f\.xml/); assert.match(m, /revert work already on main/);
  });
});

describe('staleBatchMode', () => {
  test('defaults to log; unknown values fall back to log; off and sync are honoured', () => {
    assert.equal(staleBatchMode({}), 'log');
    assert.equal(staleBatchMode({ STALE_BATCH_GUARD: 'banana' }), 'log');
    assert.equal(staleBatchMode({ STALE_BATCH_GUARD: 'SYNC' }), 'sync');
    assert.equal(staleBatchMode({ STALE_BATCH_GUARD: 'off' }), 'off');
  });
});

describe('checkOpenBatchBranches', () => {
  const site = { id: 8862, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
  const rows = [
    { branch_name: 'action-center/batch-8862-2026-11-21', pr_number: 119 },
    { branch_name: 'action-center/batch-8862-2026-11-23', pr_number: 128 },
    { branch_name: 'action-center/batch-8862-2026-11-20', pr_number: 110 },
  ];
  const status = {
    'action-center/batch-8862-2026-11-21': { behindBy: 16, headFiles: ['public/sitemap.xml'], baseFiles: ['public/sitemap.xml'] },
    'action-center/batch-8862-2026-11-23': { behindBy: 0, headFiles: [], baseFiles: [] },
    'action-center/batch-8862-2026-11-20': { behindBy: 2, headFiles: ['a'], baseFiles: ['b'] },
  };
  const mk = (extra = {}) => {
    const calls = { synced: [], logs: [], queries: [] };
    const deps = {
      getSiteById: async () => site,
      query: async (sql, params) => { calls.queries.push({ sql, params }); return { rows }; },
      baseBranch: () => 'main',
      compareBranchStatus: async (_s, base, branch) => { assert.equal(base, 'main'); return status[branch]; },
      syncBranchWithBase: async (_s, branch) => { calls.synced.push(branch); return { conflicted: false, synced: true }; },
      ...extra,
    };
    return { calls, deps };
  };

  test('log mode (the default): reports the stale branches and writes NOTHING', async () => {
    const { calls, deps } = mk();
    const r = await checkOpenBatchBranches(8862, { log: (m) => calls.logs.push(m), deps });
    assert.equal(r.mode, 'log'); assert.deepEqual([r.checked, r.current, r.behind, r.synced], [3, 1, 2, 0]);
    assert.deepEqual(calls.synced, []);
    assert.equal(calls.logs.filter((l) => /nothing was written/.test(l)).length, 2);
    assert.ok(calls.logs.some((l) => /PR #119/.test(l) && /public\/sitemap\.xml/.test(l)));
  });

  test('only open agent branches of this site are asked for', async () => {
    const { calls, deps } = mk();
    await checkOpenBatchBranches(8862, { log: () => {}, deps });
    const { sql, params } = calls.queries[0];
    assert.match(sql, /status = 'pr_opened'/); assert.match(sql, /pr_state/);
    assert.deepEqual(params, [8862, 'action-center/batch-%']);
  });

  test('sync mode: merges main into each stale branch, never into a current one', async () => {
    const { calls, deps } = mk();
    const r = await checkOpenBatchBranches(8862, { mode: 'sync', log: (m) => calls.logs.push(m), deps });
    assert.deepEqual(calls.synced, ['action-center/batch-8862-2026-11-21', 'action-center/batch-8862-2026-11-20']);
    assert.equal(r.synced, 2); assert.equal(r.held, 0);
  });

  test('sync mode: a conflict or a duplicated marker is held for a person and does not stop the other branches', async () => {
    const { calls, deps } = mk({ syncBranchWithBase: async (_s, b) => { calls.synced.push(b); return b.endsWith('21') ? { conflicted: true } : { conflicted: false, synced: true }; } });
    const r = await checkOpenBatchBranches(8862, { mode: 'sync', log: (m) => calls.logs.push(m), deps });
    assert.deepEqual([r.synced, r.held], [1, 1]);
    assert.ok(calls.logs.some((l) => /merge conflict/.test(l)));
    const marker = mk({ syncBranchWithBase: async () => ({ conflicted: true, corrupted: true }) });
    const r2 = await checkOpenBatchBranches(8862, { mode: 'sync', log: (m) => marker.calls.logs.push(m), deps: marker.deps });
    assert.equal(r2.held, 2); assert.ok(marker.calls.logs.some((l) => /duplicated marker/.test(l)));
  });

  test('one branch that cannot be read is counted and logged; the rest are still checked', async () => {
    const { calls, deps } = mk({ compareBranchStatus: async (_s, _b, branch) => { if (branch.endsWith('21')) throw new Error('GitHub 502'); return status[branch]; } });
    const r = await checkOpenBatchBranches(8862, { log: (m) => calls.logs.push(m), deps });
    assert.deepEqual([r.checked, r.failed, r.current, r.behind], [3, 1, 1, 1]);
    assert.ok(calls.logs.some((l) => /could not be checked \(GitHub 502\)/.test(l)));
  });

  test('off does nothing at all; a site with no repository is skipped', async () => {
    const { calls, deps } = mk();
    assert.equal((await checkOpenBatchBranches(8862, { mode: 'off', deps })).checked, 0);
    assert.equal(calls.queries.length, 0);
    const none = mk({ getSiteById: async () => ({ id: 1 }) });
    assert.equal((await checkOpenBatchBranches(1, { deps: none.deps })).checked, 0);
  });
});
