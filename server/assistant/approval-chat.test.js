import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApproval, pickPullRequests } from './approval-chat.js';
import { handleMessage } from './assistant.js';
import { buildNeedsYou } from './needs-you.js';

describe('classifyApproval — natural replies, read conservatively', () => {
  test('clear approvals', () => {
    for (const t of ['ok', 'Looks good, go ahead', 'yes merge it', 'ship it 👍', 'approved', 'sounds good, do it', 'all good']) assert.equal(classifyApproval(t), 'approve', t);
  });
  test('clear declines', () => {
    for (const t of ['no', 'wait', "don't merge it yet", 'hold on', 'not yet', 'stop', 'not ok']) assert.equal(classifyApproval(t), 'decline', t);
  });
  test('doubt, conditions, questions and change requests are never treated as approval', () => {
    for (const t of ['ok but change the title first', 'looks good, what does it change?', 'is it safe to merge?', 'yes, but only if the build passes', 'sure, maybe tomorrow', 'can you merge it?']) assert.notEqual(classifyApproval(t), 'approve', t);
  });
  test('unrelated chat is none', () => {
    for (const t of ['how is traffic this week', 'why did clicks drop', '']) assert.equal(classifyApproval(t), 'none', t);
    assert.equal(classifyApproval('x'.repeat(300)), 'none');
  });
  test('pickPullRequests: named, only-one, all, or ambiguous', () => {
    const p = [{ prNumber: 12 }, { prNumber: 14 }];
    assert.deepEqual(pickPullRequests('ok merge #14', p).prs, [14]);
    assert.deepEqual(pickPullRequests('go ahead with both', p).prs, [12, 14]);
    assert.deepEqual(pickPullRequests('ok', p).ambiguous, [12, 14]);
    assert.deepEqual(pickPullRequests('ok', [{ prNumber: 12 }]).prs, [12]);
    assert.deepEqual(pickPullRequests('merge #99', [{ prNumber: 12 }]).prs, [12]); // unnamed-by-match falls back to the only one
  });
});

describe('needs-you: the agent tells the person a stage PR is ready', () => {
  const drafts = [
    { id: 1, action_type: 'faq', status: 'pr_opened', pr_number: 12, pr_url: 'u', pr_base_branch: 'stage', created_at: new Date().toISOString() },
    { id: 2, action_type: 'meta-title', status: 'pr_opened', pr_number: 12, pr_url: 'u', pr_base_branch: 'stage', created_at: new Date().toISOString() },
    { id: 3, action_type: 'faq', status: 'pr_opened', pr_number: 30, pr_url: 'u', pr_base_branch: 'main', created_at: new Date().toISOString() },
    { id: 4, action_type: 'faq', status: 'pr_opened', pr_number: 31, pr_url: 'u', pr_base_branch: 'stage', pr_state: 'closed', created_at: new Date().toISOString() },
  ];
  test('one item per open stage PR; main-targeted and closed PRs never appear', () => {
    const items = buildNeedsYou({ drafts, stageBranch: 'stage' }).filter((i) => i.prNumber);
    assert.deepEqual(items.map((i) => i.prNumber), [12]);
    assert.match(items[0].title, /#12 \(2 changes\)/);
  });
  test('a site with no stage branch lists none', () => {
    assert.equal(buildNeedsYou({ drafts, stageBranch: null }).filter((i) => i.prNumber).length, 0);
  });
});

describe('handleMessage — approving in conversation', () => {
  const ctx = { siteId: 5, userId: 77, role: 'tenant_admin' };
  const item = (n) => ({ key: `approval:stage-pr:${n}`, kind: 'approval', prNumber: n, title: `Ready to merge to stage: pull request #${n}`, detail: 'faq. Tell me to go ahead and I will merge it.', ageDays: 0, count: 1, actions: [] });
  const mk = (pending, over = {}) => {
    const merged = [];
    return { merged, deps: { getSite: async () => ({ id: 5, name: 'Zennly' }), collectNeedsYou: async () => pending, mergeStagePr: async (_s, n, o) => { merged.push({ n, o }); return { ok: true, base: 'stage' }; }, afterMerge: async () => ({ opened: { number: 99 } }), ...over } };
  };
  // getSiteById reads the database; the capability's site lookup is replaced through deps in production code paths that have one —
  // here the merge function is faked so the site is never used.
  test('"looks good, go ahead" with one PR waiting merges it as the signed-in person, checks required, then mentions the main PR', async () => {
    const { merged, deps } = mk([item(12)]);
    const r = await handleMessage({ ctx, message: 'Looks good, go ahead', deps });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].o.userId, 77); assert.equal(merged[0].o.requireChecks, true);
    assert.match(r.message, /Merged #12 into stage on Zennly\./); assert.match(r.message, /pull request to main \(#99\)/);
  });
  test('a question or a condition merges nothing and asks', async () => {
    const { merged, deps } = mk([item(12)]);
    for (const m of ['ok but change the title first', 'what does it change?', 'is it safe?']) {
      const r = await handleMessage({ ctx, message: m, deps });
      assert.equal(r.state, 'NEEDS_INPUT', m); assert.match(r.message, /haven't merged anything/);
    }
    assert.equal(merged.length, 0);
  });
  test('a decline leaves it open', async () => {
    const { merged, deps } = mk([item(12)]);
    const r = await handleMessage({ ctx, message: "don't merge it yet", deps });
    assert.equal(merged.length, 0); assert.match(r.message, /leave .* open/);
  });
  test('two waiting: a bare "ok" asks which; naming one merges only that one; "all" merges both', async () => {
    let t = mk([item(12), item(14)]);
    assert.match((await handleMessage({ ctx, message: 'ok', deps: t.deps })).message, /Which one/); assert.equal(t.merged.length, 0);
    t = mk([item(12), item(14)]);
    await handleMessage({ ctx, message: 'ok merge #14', deps: t.deps }); assert.deepEqual(t.merged.map((x) => x.n), [14]);
    t = mk([item(12), item(14)]);
    await handleMessage({ ctx, message: 'go ahead with all of them', deps: t.deps }); assert.deepEqual(t.merged.map((x) => x.n), [12, 14]);
  });
  test('a guard refusal is explained plainly and nothing is claimed merged', async () => {
    const { deps } = mk([item(12)], { mergeStagePr: async () => ({ ok: false, reason: 'checks-failed', message: 'A check failed, so it was not merged.' }) });
    const r = await handleMessage({ ctx, message: 'ok', deps });
    assert.match(r.message, /did not merge #12: A check failed/); assert.equal(r.state, 'BLOCKED');
  });
  test('a member who is not an admin cannot merge', async () => {
    const { merged, deps } = mk([item(12)]);
    const r = await handleMessage({ ctx: { ...ctx, role: 'tenant_member' }, message: 'ok', deps });
    assert.equal(merged.length, 0); assert.match(r.message, /did not merge #12/);
  });
});
