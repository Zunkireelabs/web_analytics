import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { batchBranchFor, cycleDateIn, itemStateFor, decideClosure, closeDeliveryDay, recordRunIntoCycle, recordItemOutcome, getOrOpenCycle, CYCLE_STATUS } from './delivery-cycle.js';

describe('the working day is a Nepal day', () => {
  test('22:00 UTC on the 24th is already the 25th in Nepal; 17:00 Nepal is still the same day', () => {
    assert.equal(cycleDateIn('Asia/Kathmandu', new Date('2026-11-24T22:00:00Z')), '2026-11-25');
    assert.equal(cycleDateIn('Asia/Kathmandu', new Date('2026-11-25T11:15:00Z')), '2026-11-25'); // 17:00 Nepal
    assert.equal(cycleDateIn('Asia/Kolkata', new Date('2026-11-24T19:00:00Z')), '2026-11-25');
  });
});

describe('item states', () => {
  test('shipped stays shipped, failed is blocked, an already-resolved failure is not a block', () => {
    assert.equal(itemStateFor({ outcome: 'shipped' }), 'shipped');
    assert.equal(itemStateFor({ outcome: 'failed', retryPolicy: 'needs_human' }), 'blocked');
    assert.equal(itemStateFor({ outcome: 'failed', retryPolicy: 'retry' }), 'blocked');
    assert.equal(itemStateFor({ outcome: 'failed', retryPolicy: 'already_resolved' }), 'skipped');
    assert.equal(itemStateFor({ outcome: 'superseded' }), 'skipped');
  });
});

describe('how a project\'s day ends (decideClosure): every case says something', () => {
  const cyc = (o = {}) => ({ passes: 1, attempted: 0, shipped: 0, skipped: 0, pr_url: null, branch_name: null, ...o });
  test('a PR was opened: delivered, with no blocker', () => {
    const r = decideClosure({ cycle: cyc({ pr_url: 'https://github.com/x/y/pull/1', shipped: 3 }) });
    assert.deepEqual([r.status, r.blocker, r.recovery], ['delivered', null, null]);
  });
  test('a PR opened by a LATER pass (found on the drafts) still counts as delivered', () => {
    const r = decideClosure({ cycle: cyc({ shipped: 2 }), evidence: { openedPrUrl: 'https://github.com/x/y/pull/9' } });
    assert.equal(r.status, 'delivered'); assert.equal(r.prUrl, 'https://github.com/x/y/pull/9');
  });
  test('pushed work and no PR: preserved, and the recovery names the branch', () => {
    const r = decideClosure({ cycle: cyc({ shipped: 4 }), evidence: { pushedBranch: 'superrank/batch-2026-11-25' } });
    assert.equal(r.status, 'preserved');
    assert.match(r.blocker, /no pull request was opened/);
    assert.match(r.recovery, /superrank\/batch-2026-11-25/);
  });
  test('shipped work with no branch known still says where to look', () => {
    const r = decideClosure({ cycle: cyc({ shipped: 1 }) });
    assert.equal(r.status, 'preserved'); assert.match(r.recovery, /Action Center/);
  });
  test('no cycle row at all, or no pass reached it: unreached, with the last skip reason', () => {
    assert.equal(decideClosure({ cycle: null }).status, 'unreached');
    const r = decideClosure({ cycle: cyc({ passes: 0 }), lastSkip: 'window-closed' });
    assert.equal(r.status, 'unreached'); assert.match(r.blocker, /window-closed/);
  });
  test('reached, nothing eligible, nothing blocked: no-work, recorded as a result (never manufactured work)', () => {
    const r = decideClosure({ cycle: cyc({ skipped: 17 }), items: [], eligibleRemaining: 0 });
    assert.equal(r.status, 'no-work'); assert.match(r.blocker, /17 items/);
    assert.equal(decideClosure({ cycle: cyc(), items: [], eligibleRemaining: 0 }).status, 'no-work');
  });
  test('blocked items: incomplete, naming the top kinds, and the content is said to be kept', () => {
    const items = [{ state: 'blocked', blocked_kind: 'FAILED_BECAUSE_INPUT_IS_INVALID' }, { state: 'blocked', blocked_kind: 'FAILED_BECAUSE_INPUT_IS_INVALID' }, { state: 'refused', blocked_kind: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG' }];
    const r = decideClosure({ cycle: cyc({ attempted: 3 }), items, eligibleRemaining: 0 });
    assert.equal(r.status, 'incomplete');
    assert.match(r.blocker, /3 items blocked: FAILED_BECAUSE_INPUT_IS_INVALID \(2\)/);
    assert.match(r.recovery, /keep their stored content/);
  });
  test('eligible work still waiting when the day closed: incomplete, with the reason', () => {
    const r = decideClosure({ cycle: cyc({ attempted: 5 }), items: [], eligibleRemaining: 12, lastSkip: 'github-rate-limited' });
    assert.equal(r.status, 'incomplete'); assert.match(r.blocker, /12 eligible items still waiting \(github-rate-limited\)/);
    assert.equal(r.recovery, 'Waiting items are first in line on the next pass.', 'no mention of blocked items when none were blocked');
  });
  test('a closure is never "open"', () => {
    for (const input of [{ cycle: null }, { cycle: cyc() }, { cycle: cyc({ attempted: 2 }), eligibleRemaining: 3 }]) assert.notEqual(decideClosure(input).status, CYCLE_STATUS.OPEN);
  });
});

// A tiny in-memory stand-in for the three tables, enough to test the database half without a database.
function fakeDb() {
  const cycles = []; const items = []; const drafts = [];
  let id = 1;
  const query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO delivery_cycles')) {
      let c = cycles.find((x) => x.site_id === p[0] && x.cycle_date === p[1]);
      if (!c) { c = { id: id++, site_id: p[0], cycle_date: p[1], status: 'open', passes: 0, attempted: 0, shipped: 0, blocked: 0, skipped: 0, pr_url: null, branch_name: null, stages: {}, closed_at: null }; cycles.push(c); }
      return { rows: [c] };
    }
    if (q.startsWith('UPDATE delivery_cycles SET passes')) {
      const c = cycles.find((x) => x.id === p[0]); if (!c || c.closed_at) return { rows: [] };
      c.passes += p[1]; c.attempted += p[2]; c.shipped += p[3]; c.blocked += p[4]; c.skipped = Math.max(c.skipped, p[5]); c.pr_url = p[6] || c.pr_url; c.stages.lastRun = JSON.parse(p[7]);
      return { rows: [] };
    }
    if (q.startsWith('SELECT state, blocked_kind')) return { rows: items.filter((i) => i.cycle_id === p[0]) };
    if (q.includes("status = 'branch_pushed'")) return { rows: drafts.filter((d) => d.kind === 'pushed' && d.site_id === p[0] && d.branch_name === p[1]) };
    if (q.includes("status IN ('pr_opened'")) return { rows: drafts.filter((d) => d.kind === 'opened' && d.site_id === p[0] && d.branch_name === p[1]) };
    if (q.startsWith('UPDATE delivery_cycles SET status')) {
      const c = cycles.find((x) => x.id === p[0]); if (!c || c.closed_at) return { rows: [] };
      Object.assign(c, { status: p[1], blocker: p[2], recovery: p[3], branch_name: p[4] || c.branch_name, pr_url: p[6] || c.pr_url, closed_at: new Date() });
      return { rows: [] };
    }
    if (q.startsWith('INSERT INTO delivery_items')) {
      // params: cycle, site, recommendation, finding, draft, generator, page, state, blocked_kind, blocked_reason, retry_policy, skip_reason, history
      const rec = p[2];
      const existing = rec == null ? null : items.find((i) => i.cycle_id === p[0] && i.recommendation_id === rec);
      const row = { cycle_id: p[0], site_id: p[1], recommendation_id: rec, state: p[7], blocked_kind: p[8], skip_reason: p[11], attempts: 1 };
      if (existing) { Object.assign(existing, { state: row.state, blocked_kind: row.blocked_kind, skip_reason: row.skip_reason }); existing.attempts += 1; } else items.push(row);
      return { rows: [] };
    }
    throw new Error(`fakeDb: unexpected SQL: ${q.slice(0, 80)}`);
  };
  return { query, cycles, items, drafts };
}
const NOW = new Date('2026-11-25T11:15:00Z'); // 17:00 Nepal
const TZ = 'Asia/Kathmandu';

describe('recording into the day (fake database)', () => {
  test('runs add up across the day\'s passes; a skipped run counts no pass but is remembered', async () => {
    const db = fakeDb();
    await recordRunIntoCycle(8864, { attempted: 4, shipped: 1, failed: 3, refused: 3, skipped: 10, prUrl: 'https://x/pull/70', selection: {} }, { timezone: TZ, now: NOW, query: db.query });
    await recordRunIntoCycle(8864, { attempted: 2, shipped: 0, failed: 2, refused: 2, skipped: 8, selection: {} }, { timezone: TZ, now: NOW, query: db.query });
    await recordRunIntoCycle(8864, { attempted: 0, stoppedReason: 'window-closed', selection: { runSkipped: true } }, { timezone: TZ, now: NOW, query: db.query });
    const c = db.cycles[0];
    assert.deepEqual([c.passes, c.attempted, c.shipped, c.blocked, c.skipped, c.pr_url], [2, 6, 1, 10, 10, 'https://x/pull/70']);
    assert.equal(c.stages.lastRun.reached, false); assert.equal(c.stages.lastRun.stoppedReason, 'window-closed');
  });
  test('a retry of the same item the same day updates one row, it does not add rows', async () => {
    const db = fakeDb();
    const a = { recommendationId: 77, findingId: 'f', draftId: 5, outcome: 'failed', failureClass: 'FAILED_BECAUSE_INPUT_IS_INVALID', retryPolicy: 'needs_human', reason: 'held' };
    await recordItemOutcome(1, a, { timezone: TZ, now: NOW, query: db.query });
    await recordItemOutcome(1, { ...a, outcome: 'shipped', failureClass: null, retryPolicy: null }, { timezone: TZ, now: NOW, query: db.query });
    assert.equal(db.items.length, 1); assert.equal(db.items[0].state, 'shipped'); assert.equal(db.items[0].attempts, 2);
  });
  test('a design-pending skip is kept as a skipped item with its reason, and counts as nothing against the item', async () => {
    const db = fakeDb();
    await recordItemOutcome(8862, { recommendationId: 9, generatorId: 'blog-outline', page: '/blog/x', skipReason: 'design-pending', reason: 'its group\'s layout no longer matches' }, { timezone: TZ, now: NOW, query: db.query });
    assert.deepEqual([db.items[0].state, db.items[0].skip_reason, db.items[0].blocked_kind], ['skipped', 'design-pending', null]);
  });
  test('recording can never throw into the shipping run, even if the database is gone', async () => {
    const dead = async () => { throw new Error('connection refused'); };
    const origErr = console.error; console.error = () => {};
    try {
      assert.equal(await recordRunIntoCycle(1, { attempted: 1 }, { timezone: TZ, now: NOW, query: dead }), null);
      await recordItemOutcome(1, { recommendationId: 1, outcome: 'failed' }, { timezone: TZ, now: NOW, query: dead });
    } finally { console.error = origErr; }
  });
});

describe('today\'s delivery is the project\'s batch branch of today', () => {
  test('the name is exactly the one the shipping code gives its batch branch', async () => {
    const { batchBranchName } = await import('../implementers/lib/github-ops.js');
    for (const [tz, at] of [['UTC', '2026-11-25T11:15:00Z'], ['Asia/Kolkata', '2026-11-24T19:00:00Z'], ['Asia/Kathmandu', '2026-11-24T20:30:00Z'], [undefined, '2026-11-25T01:00:00Z']]) {
      const site = { id: 8862, timezone: tz };
      assert.equal(batchBranchFor(site, new Date(at)), batchBranchName(site, new Date(at)), `${tz} ${at}`);
    }
  });
  test('an OLD pull request that merely looks recent (its draft was touched today by the status poll) is not today\'s delivery', async () => {
    const db = fakeDb();
    db.drafts.push({ kind: 'opened', site_id: 8872, branch_name: 'action-center/batch-8872-2026-11-21', pr_url: 'https://github.com/Zunkireelabs/web-zenly/pull/50' });
    const [r] = await closeDeliveryDay({ sites: [{ id: 8872, timezone: 'Asia/Kathmandu' }], timezone: TZ, now: NOW, query: db.query });
    assert.notEqual(r.status, 'delivered');
    assert.equal(r.status, 'unreached');
  });
});

describe('closing the day (fake database)', () => {
  test('every project gets a closed record, including ones no pass ever recorded', async () => {
    const db = fakeDb();
    await recordRunIntoCycle(1, { attempted: 5, shipped: 0, failed: 5, skipped: 3, selection: {} }, { timezone: TZ, now: NOW, query: db.query });
    const sites = [1, 8862, 8864, 8871, 8872, 8874].map((id) => ({ id }));
    const out = await closeDeliveryDay({ sites, timezone: TZ, now: NOW, query: db.query, eligibleFor: async () => 0 });
    assert.equal(out.length, 6);
    assert.equal(db.cycles.length, 6, 'a row exists for every project');
    assert.ok(db.cycles.every((c) => c.closed_at && c.status !== 'open'));
    assert.equal(db.cycles.find((c) => c.site_id === 8862).status, 'unreached');
    assert.equal(db.cycles.find((c) => c.site_id === 1).status, 'incomplete', 'work was attempted and nothing shipped: that is not "no work"');
    assert.match(db.cycles.find((c) => c.site_id === 1).blocker, /nothing shipped/);
  });
  test('closing is idempotent: a second close (a restart after 17:00) changes nothing', async () => {
    const db = fakeDb();
    await closeDeliveryDay({ sites: [{ id: 1 }], timezone: TZ, now: NOW, query: db.query });
    const first = { ...db.cycles[0] };
    const again = await closeDeliveryDay({ sites: [{ id: 1 }], timezone: TZ, now: new Date(NOW.getTime() + 600_000), query: db.query });
    assert.equal(again[0].already, true);
    assert.equal(db.cycles[0].closed_at.getTime(), first.closed_at.getTime());
  });
  test('one project failing to close does not stop the others, and says so', async () => {
    const db = fakeDb();
    const flaky = async (sql, p) => { if (/INSERT INTO delivery_cycles/.test(sql) && p[0] === 8864) throw new Error('db hiccup'); return db.query(sql, p); };
    const origErr = console.error; console.error = () => {};
    let out; try { out = await closeDeliveryDay({ sites: [{ id: 1 }, { id: 8864 }, { id: 8872 }], timezone: TZ, now: NOW, query: flaky }); } finally { console.error = origErr; }
    assert.deepEqual(out.map((r) => r.status), ['unreached', 'failed-to-close', 'unreached']);
    assert.match(out[1].error, /db hiccup/);
  });
  test('preserved work is found from the drafts (pushed branch, no PR) and the PR from a later pass counts as delivered', async () => {
    const db = fakeDb();
    db.drafts.push({ kind: 'pushed', site_id: 1, branch_name: 'action-center/batch-1-2026-11-25' });
    db.drafts.push({ kind: 'opened', site_id: 8862, branch_name: 'action-center/batch-8862-2026-11-25', pr_url: 'https://github.com/Zunkireelabs/admizz-web-dev/pull/137' });
    const out = await closeDeliveryDay({ sites: [{ id: 1 }, { id: 8862 }], timezone: TZ, now: NOW, query: db.query });
    assert.equal(out[0].status, 'preserved'); assert.match(out[0].recovery, /action-center\/batch-1-2026-11-25/);
    assert.equal(out[1].status, 'delivered');
    assert.equal(db.cycles.find((c) => c.site_id === 8862).pr_url, 'https://github.com/Zunkireelabs/admizz-web-dev/pull/137');
  });
});

// A real Postgres (the LOCAL sr-local-pg container only; never a production URL). Skipped unless DELIVERY_CYCLE_PG_URL is set.
const PG = process.env.DELIVERY_CYCLE_PG_URL;
describe('against a real local Postgres (migrations 268-269)', { skip: !PG }, () => {
  test('the real SQL runs: cycle, items, close, idempotence, unique day', async () => {
    const pg = (await import('pg')).default;
    assert.match(PG, /localhost:55432|127\.0\.0\.1:55432/, 'refusing to run against anything but the local container');
    const pool = new pg.Pool({ connectionString: PG });
    const query = (sql, p) => pool.query(sql, p);
    try {
      const { rows: [site] } = await pool.query('SELECT id FROM sites ORDER BY id LIMIT 1');
      await pool.query(`DELETE FROM delivery_cycles WHERE site_id = $1 AND cycle_date = '2026-11-25'`, [site.id]);
      await recordRunIntoCycle(site.id, { attempted: 3, shipped: 0, failed: 3, refused: 3, skipped: 4, selection: { eligible: 3 } }, { timezone: TZ, now: NOW, query });
      await recordItemOutcome(site.id, { recommendationId: 4242, findingId: 'f1', draftId: null, outcome: 'failed', failureClass: 'FAILED_BECAUSE_INPUT_IS_INVALID', retryPolicy: 'needs_human', reason: 'held by the design check' }, { timezone: TZ, now: NOW, query });
      await recordItemOutcome(site.id, { recommendationId: 4242, findingId: 'f1', outcome: 'failed', failureClass: 'FAILED_BECAUSE_INPUT_IS_INVALID', retryPolicy: 'needs_human', reason: 'held again' }, { timezone: TZ, now: NOW, query });
      const cycle = await getOrOpenCycle(site.id, { timezone: TZ, now: NOW, query });
      const { rows: items } = await pool.query('SELECT * FROM delivery_items WHERE cycle_id = $1', [cycle.id]);
      assert.equal(items.length, 1); assert.equal(items[0].attempts, 2); assert.equal(items[0].history.length, 2); assert.equal(items[0].state, 'blocked');
      const out = await closeDeliveryDay({ sites: [{ id: site.id }], timezone: TZ, now: NOW, query, eligibleFor: async () => 0 });
      assert.equal(out[0].status, 'incomplete');
      const again = await closeDeliveryDay({ sites: [{ id: site.id }], timezone: TZ, now: NOW, query });
      assert.equal(again[0].already, true);
      const { rows: [row] } = await pool.query('SELECT status, closed_at, passes, attempted, blocked FROM delivery_cycles WHERE id = $1', [cycle.id]);
      assert.deepEqual([row.status, !!row.closed_at, row.passes, row.attempted, row.blocked], ['incomplete', true, 1, 3, 6]);
      await pool.query(`DELETE FROM delivery_cycles WHERE id = $1`, [cycle.id]);
    } finally { await pool.end(); }
  });
});
