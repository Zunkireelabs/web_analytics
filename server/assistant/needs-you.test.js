import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildNeedsYou, collectNeedsYou, KIND } from './needs-you.js';
import { composeNeedsYou, classifyIntent } from './assistant.js';
import { invokeCapability } from './capabilities.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
const draft = (o) => ({ id: 1, action_type: 'meta-title', status: 'draft', created_at: day(1), apply_error: null, pr_state: null, ...o });

describe('buildNeedsYou', () => {
  test('nothing waiting gives an empty list', () => assert.deepEqual(buildNeedsYou({ now: NOW }), []));
  test('drafts awaiting approval are split by page, each with the oldest age and its own Review link', () => {
    const items = buildNeedsYou({ drafts: [draft({ id: 1, created_at: day(2) }), draft({ id: 2, status: 'submitted_for_approval', action_type: 'blog-outline', created_at: day(5) }), draft({ id: 3, action_type: 'landing-page', created_at: day(1) }), draft({ id: 4, status: 'implemented' })], now: NOW });
    const fixes = items.find((i) => i.key === 'approval:fixes'), content = items.find((i) => i.key === 'approval:content');
    assert.equal(fixes.count, 1);
    assert.equal(fixes.link, '/action-center');
    assert.equal(content.count, 2);
    assert.equal(content.ageDays, 5);
    assert.equal(content.link, '/content?view=review');
    assert.deepEqual(content.ids.sort(), [2, 3]);
  });
  test('there is no approve-all in the needs-you list: Review is the only action', () => {
    const items = buildNeedsYou({ drafts: [draft({ id: 1 }), draft({ id: 2, action_type: 'blog-outline' })], now: NOW });
    for (const i of items) assert.deepEqual(i.actions.map((a) => a.id), ['review_drafts']);
  });
  test('an opened stage-to-main PR is an approval for main', () => {
    const items = buildNeedsYou({ stagePromotions: [{ source_pr_number: 4, status: 'opened', promotion_pr_number: 9, promotion_pr_url: 'u', created_at: day(0) }], now: NOW });
    assert.equal(items[0].actions[0].id, 'approve_main');
    assert.equal(items[0].actions[0].pr, 9);
  });
  test('a waiting or blocked promotion is not offered for approval', () => {
    assert.deepEqual(buildNeedsYou({ stagePromotions: [{ source_pr_number: 4, status: 'waiting', promotion_pr_number: null, promotion_pr_url: null }], now: NOW }), []);
  });
  test('a failed apply and a closed PR are shipping-blocking issues and come first', () => {
    const items = buildNeedsYou({ drafts: [draft({ id: 1 }), draft({ id: 2, apply_error: 'conflict in page.js' }), draft({ id: 3, status: 'pr_opened', pr_state: 'closed' })], now: NOW });
    assert.deepEqual(items.map((i) => i.key), ['issue:stuck-drafts', 'issue:closed-prs', 'approval:fixes']);
    assert.ok(items[0].blocksShipping);
  });
  test('failed agents and unresolved decisions each appear', () => {
    const items = buildNeedsYou({ agentRuns: [{ agent_id: 'authority', status: 'error', created_at: day(0) }, { agent_id: 'x', status: 'ok' }], unresolved: [{ id: 7, subject: 'industry', category: 'c', created_at: day(3) }], now: NOW });
    assert.deepEqual(items.map((i) => i.kind).sort(), [KIND.DECISION, KIND.ISSUE]);
    assert.equal(items.find((i) => i.kind === KIND.DECISION).findingId, 7);
  });
});

describe('connection issues', () => {
  test('a broken Google connection is a shipping-blocking issue with a reconnect action', () => {
    const [i] = buildNeedsYou({ connections: [{ provider: 'google', siteId: 3, status: 'error', status_error: 'token revoked' }], now: NOW });
    assert.equal(i.kind, KIND.ISSUE);
    assert.equal(i.actions[0].provider, 'google');
    assert.ok(i.blocksShipping);
  });
  test('a healthy connection raises nothing', () => {
    assert.deepEqual(buildNeedsYou({ connections: [{ provider: 'google', status: 'ok' }, { provider: 'posthog', status: 'ok' }], now: NOW }), []);
  });
  test('PostHog appears only for a site that has it connected AND broken', async () => {
    const run = (posthog) => collectNeedsYou(1, { now: NOW, db: async () => ({ rows: [] }), unresolvedFn: async () => [], runsFn: async () => [], googleFn: async () => null, posthogFn: async () => posthog });
    assert.deepEqual(await run({ connected: false, status: null }), []);
    assert.deepEqual(await run({ connected: true, status: 'ok' }), []);
    assert.equal((await run({ connected: true, status: 'error' }))[0].actions[0].provider, 'posthog');
  });
});

describe('collectNeedsYou and the capability', () => {
  test('reads this site only and survives one failing source', async () => {
    const seen = [];
    const db = async (sql, params) => { seen.push(params[0]); if (/stage_promotions/.test(sql)) throw new Error('boom'); return { rows: [draft({ id: 5 })] }; };
    const items = await collectNeedsYou(42, { now: NOW, db, unresolvedFn: async () => [], runsFn: async () => [] });
    assert.deepEqual([...new Set(seen)], [42]);
    assert.equal(items[0].count, 1);
  });
  test('get_needs_you is open to every role and uses the session site', async () => {
    let used;
    const r = await invokeCapability('get_needs_you', { siteId: 3, role: 'tenant_member' }, {}, { collectNeedsYou: async (id) => { used = id; return []; } });
    assert.equal(r.ok, true);
    assert.equal(used, 3);
  });
});

describe('asking for the full list', () => {
  test('these questions reach the findings intent', () => {
    for (const q of ['what did you find to fix?', 'show me everything waiting for me', "what's broken?", 'give me the full list']) assert.equal(classifyIntent(q), 'findings', q);
  });
  test('the answer is grouped, and says so when nothing is waiting', () => {
    const text = composeNeedsYou(buildNeedsYou({ drafts: [draft({})], agentRuns: [{ agent_id: 'a', status: 'error' }], now: NOW }));
    assert.match(text, /Waiting for your approval:/);
    assert.match(text, /Issues I found:/);
    assert.match(composeNeedsYou([]), /Nothing is waiting on you/);
  });
});
