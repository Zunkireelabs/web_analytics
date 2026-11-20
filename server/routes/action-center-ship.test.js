import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pushApprovedDrafts, openPrForPushedDrafts, shipState } from './action-center.js';

// The client's "Yes, open the PR": every approved draft goes on the day's one branch and ONE pull request is opened. Fakes stand in for
// GitHub and the database, so these run anywhere.
const site = { id: 1, repo_owner: 'o', repo_name: 'r' };
const draft = (id, type = 'meta-title') => ({ id, action_type: type, status: 'approved' });
const mk = (over = {}) => {
  const calls = [];
  return { calls, deps: {
    siteFn: async () => site, listFn: async () => over.list || [draft(1), draft(2)],
    branchFn: () => 'action-center/batch-x',
    beginFn: (s, b) => calls.push(`begin:${b}`),
    pushFn: async (siteId, id) => { calls.push(`push:${id}`); if (over.failIds?.includes(id)) throw new Error('no confident insertion point'); return { id, status: 'branch_pushed' }; },
    finalizeFn: async (s, b, ids) => { calls.push(`finalize:${ids.join(',')}`); return over.finalize || { ok: true, pushed: ids.length, prNumber: 244, prUrl: 'u' }; },
    failFn: async (siteId, id, err) => { calls.push(`fail:${id}`); },
  } };
};

describe('pushApprovedDrafts (commit and push, no PR)', () => {
  const mk2 = (over = {}) => {
    const calls = [];
    return { calls, deps: {
      siteFn: async () => site, listFn: async () => over.list || [draft(1), draft(2)], branchFn: () => 'action-center/batch-x',
      beginFn: (s, b) => calls.push(`begin:${b}`),
      pushFn: async (siteId, id) => { calls.push(`push:${id}`); if (over.failIds?.includes(id)) throw new Error('no confident insertion point'); return { id, status: 'branch_pushed' }; },
      endFn: async () => { calls.push('end'); return over.end || { ok: true, pushed: 1 }; },
      failFn: async (siteId, id) => { calls.push(`fail:${id}`); },
    } };
  };
  test('approved drafts go on one branch and the branch is pushed once, with no PR opened', async () => {
    const { calls, deps } = mk2();
    const r = await pushApprovedDrafts(1, {}, deps);
    assert.deepEqual(calls, ['begin:action-center/batch-x', 'push:1', 'push:2', 'end']);
    assert.deepEqual([r.ok, r.pushed, r.failed], [true, 2, 0]);
  });
  test('only the page\'s own drafts: content does not push fixes and fixes do not push content', async () => {
    const list = [draft(1, 'meta-title'), draft(2, 'blog-outline'), draft(3, 'landing-page')];
    const a = mk2({ list }); await pushApprovedDrafts(1, { scope: 'content' }, a.deps);
    assert.deepEqual(a.calls.filter((c) => c.startsWith('push')), ['push:2', 'push:3']);
    const b = mk2({ list }); await pushApprovedDrafts(1, { scope: 'fixes' }, b.deps);
    assert.deepEqual(b.calls.filter((c) => c.startsWith('push')), ['push:1']);
  });
  test('nothing approved means GitHub is not touched at all', async () => {
    const { calls, deps } = mk2({ list: [] });
    assert.equal((await pushApprovedDrafts(1, {}, deps)).pushed, 0);
    assert.deepEqual(calls, []);
  });
  test('one draft that cannot be applied is counted and does not stop the others', async () => {
    const { deps } = mk2({ list: [draft(1), draft(2), draft(3)], failIds: [2] });
    const r = await pushApprovedDrafts(1, {}, deps);
    assert.deepEqual([r.ok, r.pushed, r.failed], [true, 2, 1]);
  });
  test('if the push fails, the applied drafts are left re-attemptable and the failure is reported', async () => {
    const { calls, deps } = mk2({ end: { ok: false, error: 'GitHub is out of budget', rateLimited: true } });
    const r = await pushApprovedDrafts(1, {}, deps);
    assert.deepEqual(calls.filter((c) => c.startsWith('fail')), ['fail:1', 'fail:2']);
    assert.deepEqual([r.ok, r.rateLimited, r.pushed], [false, true, 0]);
  });
  test('a site with no repository is a clear 400, before anything is pushed', async () => {
    const { calls, deps } = mk2();
    await assert.rejects(pushApprovedDrafts(1, {}, { ...deps, siteFn: async () => ({ id: 1 }) }), (e) => e.status === 400);
    assert.deepEqual(calls, []);
  });
});

describe('openPrForPushedDrafts (the PR, as the next question)', () => {
  const pushedDraft = (id, type = 'meta-title') => ({ id, action_type: type, status: 'branch_pushed', branch_name: 'action-center/batch-x' });
  test('one PR is opened from the first draft and every other draft on the branch gets that same PR', async () => {
    const calls = [];
    const r = await openPrForPushedDrafts(1, {}, {
      listFn: async () => [pushedDraft(1), pushedDraft(2), pushedDraft(3)],
      openFn: async (siteId, id) => { calls.push(`open:${id}`); return { pr_number: 244, pr_url: 'u' }; },
      markFn: async (siteId, id, x) => { calls.push(`mark:${id}:${x.prNumber}`); },
    });
    assert.deepEqual(calls, ['open:1', 'mark:2:244', 'mark:3:244']);
    assert.deepEqual([r.ok, r.opened, r.prNumber], [true, 3, 244]);
  });
  test('nothing on a branch means no PR is opened', async () => {
    const r = await openPrForPushedDrafts(1, {}, { listFn: async () => [], openFn: async () => { throw new Error('must not open'); } });
    assert.equal(r.opened, 0);
  });
  test('a PR that cannot be opened is reported, not hidden', async () => {
    const r = await openPrForPushedDrafts(1, {}, { listFn: async () => [pushedDraft(1)], openFn: async () => { throw new Error('GitHub 422'); } });
    assert.deepEqual([r.ok, r.error], [false, 'GitHub 422']);
  });
  test('only the page\'s own drafts are opened', async () => {
    const calls = [];
    await openPrForPushedDrafts(1, { scope: 'content' }, { listFn: async () => [pushedDraft(1, 'meta-title'), pushedDraft(2, 'blog-outline')], openFn: async (s, id) => { calls.push(id); return { pr_number: 1, pr_url: 'u' }; }, markFn: async () => {} });
    assert.deepEqual(calls, [2]);
  });
});

describe('shipState', () => {
  test('reads the step from the page\'s own drafts', async () => {
    const r = await shipState(1, 'content', {
      siteFn: async () => ({ repo_default_branch: 'main', pr_target_branch: 'stage' }),
      listFn: async () => [{ id: 1, action_type: 'blog-outline', status: 'approved' }, { id: 2, action_type: 'meta-title', status: 'pr_opened', pr_number: 9, pr_base_branch: 'stage' }],
      promoFn: async () => [],
    });
    assert.deepEqual([r.step, r.count], ['push_branch', 1]); // the fix's open PR is not this page's business
  });
});
