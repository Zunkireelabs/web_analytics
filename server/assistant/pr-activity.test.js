import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, periodFromMessage, composePrs, handleMessage } from './assistant.js';
import { invokeCapability } from './capabilities.js';

// Fake db: answers the window query, then the three PR queries by recognising each one's SQL.
function fakeDb({ opened = [], merged = [], open = [] } = {}) {
  const calls = [];
  const db = async (sql, params) => {
    calls.push({ sql, params });
    if (/AS since,/.test(sql) && /AS until/.test(sql)) return { rows: [{ since: '2026-11-23T00:00:00Z', until: '2026-11-23T12:00:00Z' }] };
    if (/FROM deployments/.test(sql)) return { rows: merged };
    if (/pr_state = 'open'/.test(sql)) return { rows: open };
    if (/auto_remediation_runs/.test(sql)) return { rows: opened };
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  };
  return { db, calls };
}
const ctx = { siteId: 7, userId: 1, role: 'tenant_member' };

describe('PR questions route to the records, not the AI', () => {
  test('intent', () => {
    for (const m of ['did any PR go out today?', 'any pull requests yesterday', 'what got merged this week', 'was anything deployed today', 'PRs?']) {
      assert.equal(classifyIntent(m), 'prs', m);
    }
    assert.notEqual(classifyIntent('what is the price of the product'), 'prs');
  });

  test('period', () => {
    assert.equal(periodFromMessage('any PR today'), 'today');
    assert.equal(periodFromMessage('PRs yesterday?'), 'yesterday');
    assert.equal(periodFromMessage('PRs this week'), 'week');
    assert.equal(periodFromMessage('PRs in the last 7 days'), 'week');
    assert.equal(periodFromMessage('any PR?'), 'today');
  });
});

describe('get_pr_activity', () => {
  test('uses the site time zone, falls back to UTC for an unknown one', async () => {
    const a = fakeDb();
    await invokeCapability('get_pr_activity', ctx, { period: 'today' }, { db: a.db, getSite: async () => ({ timezone: 'Asia/Kathmandu' }) });
    assert.deepEqual(a.calls[0].params, ['Asia/Kathmandu', 'today']);
    const b = fakeDb();
    await invokeCapability('get_pr_activity', ctx, { period: 'nonsense' }, { db: b.db, getSite: async () => ({ timezone: 'Mars/Olympus' }) });
    assert.deepEqual(b.calls[0].params, ['UTC', 'today']);
  });

  test('scoped to the caller\'s site only, and one merge counted once', async () => {
    const { db, calls } = fakeDb({
      opened: [{ pr_url: 'https://github.com/o/r/pull/41', pr_number: 41, fixes: 3, types: 'faq, meta-title', pr_state: 'open' },
        { pr_url: 'https://github.com/o/r/pull/42', pr_number: null, fixes: 0 }],
      merged: [{ pr_url: null, pr_number: 40, merged_at: '2026-11-23T05:00:00Z' }, { pr_url: 'https://github.com/o/r/pull/40', pr_number: 40, merged_at: '2026-11-23T05:01:00Z' }],
      open: [{ pr_url: 'https://github.com/o/r/pull/41', pr_number: 41, fixes: 3, since: '2026-11-23T04:00:00Z' }],
    });
    const r = await invokeCapability('get_pr_activity', ctx, { period: 'today' }, { db, getSite: async () => ({ timezone: 'UTC' }) });
    for (const c of calls.slice(1)) assert.equal(c.params[0], 7);
    assert.deepEqual(r.data.opened.map((p) => p.number), [41, 42]); // 42 parsed from the run's URL
    assert.deepEqual(r.data.merged.map((p) => p.number), [40]);
    assert.equal(r.data.open.length, 1);
  });
});

describe('composePrs', () => {
  test('nothing happened, nothing open', () => {
    const m = composePrs({ period: 'today', timeZone: 'UTC', opened: [], merged: [], open: [] });
    assert.match(m, /No pull request was opened or merged today/);
    assert.match(m, /No pull request is open right now/);
  });

  test('lists opened, merged and open PRs with links', () => {
    const m = composePrs({
      period: 'yesterday', timeZone: 'Asia/Kathmandu',
      opened: [{ number: 41, url: 'https://github.com/o/r/pull/41', fixes: 3, types: 'faq, meta-title', state: 'open' }],
      merged: [{ number: 40, url: 'https://github.com/o/r/pull/40' }],
      open: [{ number: 41, url: 'https://github.com/o/r/pull/41', fixes: 3, since: new Date().toISOString() }],
    });
    assert.match(m, /^Yesterday: 1 pull request opened, 1 merged\./);
    assert.match(m, /Opened #41 \(3 fixes: faq, meta-title\), now open — https:\/\/github.com\/o\/r\/pull\/41/);
    assert.match(m, /Merged #40/);
    assert.match(m, /Open right now.*1 pull request/);
    assert.match(m, /Asia\/Kathmandu/);
  });
});

describe('handleMessage fast path', () => {
  test('a PR question is answered without the onboarding reads or the AI', async () => {
    const { db, calls } = fakeDb();
    const r = await handleMessage({ ctx, message: 'did any PR go out today?', deps: { db, getSite: async () => ({ timezone: 'UTC' }) } });
    assert.match(r.message, /No pull request was opened or merged today/);
    assert.equal(calls.length, 4); // window + 3 PR queries, nothing else
  });

  test('a database error becomes a plain reply, not a crash', async () => {
    const r = await handleMessage({ ctx, message: 'any PRs today', deps: { db: async () => { throw new Error('down'); }, getSite: async () => null } });
    assert.match(r.message, /could not read the pull request records/);
  });
});
