import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { consolidateDay, buildPreservedDelivery, renderPreservedDeliveryMarkdown } from './delivery-consolidation.js';
import { closeDeliveryDay, batchBranchFor } from './delivery-cycle.js';
import { deliveryConsolidationCron, deliveryCloseCron, closeIsForced } from './worker-session.js';

const NOW = new Date('2026-11-25T10:45:00Z'); // 16:30 Nepal
const TZ = 'Asia/Kathmandu';
const mkSite = (id, extra = {}) => ({ id, name: `Client ${id}`, timezone: 'Asia/Kolkata', repo_owner: 'Zunkireelabs', repo_name: `web-${id}`, repo_default_branch: 'main', ...extra });

// An in-memory stand-in for drafts + delivery_cycles, answering exactly the SQL these modules issue.
function fakeDb({ drafts = [] } = {}) {
  const cycles = []; let id = 1;
  const query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith("SELECT id, action_type, finding_id, apply_error, validation_status FROM drafts")) return { rows: drafts.filter((d) => d.site_id === p[0] && d.status === 'branch_pushed' && !d.pr_number && d.branch_name === p[1]) };
    if (q.startsWith('SELECT pr_url FROM drafts') && q.includes('LIMIT 1') && !q.includes("status IN ('pr_opened'")) return { rows: drafts.filter((d) => d.site_id === p[0] && d.pr_url && d.pr_number && d.branch_name === p[1]).slice(0, 1) };
    if (q.includes("status IN ('pr_opened'")) return { rows: drafts.filter((d) => d.site_id === p[0] && d.pr_url && d.pr_number && d.branch_name === p[1]).slice(0, 1) };
    if (q.includes("status = 'branch_pushed' AND pr_number IS NULL AND branch_name = $2 LIMIT 1")) return { rows: drafts.filter((d) => d.site_id === p[0] && d.status === 'branch_pushed' && !d.pr_number && d.branch_name === p[1]).slice(0, 1) };
    if (q.startsWith('INSERT INTO delivery_cycles')) {
      let c = cycles.find((x) => x.site_id === p[0] && x.cycle_date === p[1]);
      if (!c) { c = { id: id++, site_id: p[0], cycle_date: p[1], status: 'open', passes: 1, attempted: 0, shipped: 0, blocked: 0, skipped: 0, pr_url: null, branch_name: null, stages: {}, closed_at: null }; cycles.push(c); }
      return { rows: [c] };
    }
    if (q.startsWith('UPDATE delivery_cycles SET branch_name')) { const c = cycles.find((x) => x.site_id === p[0] && x.cycle_date === p[1]); c.branch_name = p[2]; c.head_sha = p[3] || c.head_sha; c.stages.delivery = JSON.parse(p[4]); return { rows: [] }; }
    if (q.startsWith('SELECT state, blocked_kind')) return { rows: [] };
    if (q.startsWith('UPDATE delivery_cycles SET status')) { const c = cycles.find((x) => x.id === p[0]); if (c.closed_at) return { rows: [] }; Object.assign(c, { status: p[1], blocker: p[2], recovery: p[3], pr_url: p[6] || c.pr_url, closed_at: new Date() }); return { rows: [] }; }
    throw new Error(`fakeDb: unexpected SQL: ${q.slice(0, 90)}`);
  };
  return { query, cycles, drafts };
}
const pushed = (siteId, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: siteId * 100 + i, site_id: siteId, status: 'branch_pushed', pr_number: null, branch_name: batchBranchFor(mkSite(siteId), NOW), action_type: 'faq', finding_id: `f${siteId}-${i}`, apply_error: null, validation_status: 'passed', ...extra }));

describe('the deadline step brings each project to one pull request, or preserves the work', () => {
  test('a project with nothing pushed has nothing to open (no manufactured work)', async () => {
    const db = fakeDb(); let recovered = 0;
    const [r] = await consolidateDay({ sites: [mkSite(8874)], now: NOW, timezone: TZ, query: db.query, recover: async () => { recovered++; }, log: () => {} });
    assert.equal(r.outcome, 'nothing-to-open'); assert.equal(recovered, 0);
  });

  test('pushed work whose PR opens on this attempt ends as delivered, and nothing is preserved', async () => {
    const db = fakeDb({ drafts: pushed(8864, 4) });
    const recover = async (siteId) => { for (const d of db.drafts.filter((x) => x.site_id === siteId)) Object.assign(d, { status: 'pr_opened', pr_number: 70, pr_url: 'https://github.com/Zunkireelabs/web-8864/pull/70' }); };
    const [r] = await consolidateDay({ sites: [mkSite(8864)], now: NOW, timezone: TZ, query: db.query, recover, log: () => {} });
    assert.deepEqual([r.outcome, r.prUrl], ['delivered', 'https://github.com/Zunkireelabs/web-8864/pull/70']);
    assert.equal(db.cycles.length, 0, 'no preserved record when the PR opened');
  });

  test('a GitHub rate limit while opening the PR: the work is PRESERVED with branch, items, exact error and a recovery command; nothing is lost', async () => {
    const db = fakeDb({ drafts: pushed(1, 3, { apply_error: 'GitHub rate limit reached for /repos/Zunkireelabs/web-1/pulls (resets 2026-11-25T11:00:00Z)' }) });
    const recover = async () => { throw Object.assign(new Error('GitHub rate limit reached for /repos/Zunkireelabs/web-1/pulls (resets 2026-11-25T11:00:00Z)'), { rateLimited: true }); };
    const [r] = await consolidateDay({ sites: [mkSite(1)], now: NOW, timezone: TZ, query: db.query, recover, describeBranch: async () => ({ headSha: 'abc123def456', commitSubjects: ['Action Center: apply faq draft #100'] }), log: () => {} });
    assert.equal(r.outcome, 'preserved');
    const d = r.delivery;
    assert.equal(d.branch, 'action-center/batch-1-2026-11-25'); assert.equal(d.itemCount, 3); assert.equal(d.headSha, 'abc123def456');
    assert.equal(d.cause, 'github-rate-limit'); assert.match(d.exactError, /rate limit reached/);
    assert.match(d.recovery.byHand[0], /gh pr create --repo Zunkireelabs\/web-1 --base main --head action-center\/batch-1-2026-11-25/);
    assert.match(d.recovery.nothingLost, /nothing needs regenerating/);
    assert.equal(db.drafts.filter((x) => x.status === 'branch_pushed').length, 3, 'the drafts were not touched');
    const cycle = db.cycles[0]; assert.equal(cycle.branch_name, d.branch); assert.equal(cycle.stages.delivery.itemCount, 3);
  });

  test('a project whose shipping pass is still running is DEFERRED and never touched (recovery can abandon an in-flight batch)', async () => {
    const db = fakeDb({ drafts: pushed(8871, 2) }); let recovered = 0;
    const [r] = await consolidateDay({ sites: [mkSite(8871)], now: NOW, timezone: TZ, query: db.query, isLocked: async () => true, recover: async () => { recovered++; }, log: () => {} });
    assert.equal(r.outcome, 'deferred'); assert.equal(recovered, 0, 'the recovery that abandons missing commits must not run mid-pass');
  });

  test('one project failing does not stop the other five: every project gets its own result', async () => {
    const sites = [1, 8862, 8864, 8871, 8872, 8874].map((id) => mkSite(id));
    const db = fakeDb({ drafts: [...pushed(8862, 1), ...pushed(8872, 2)] });
    const flaky = async (sql, p) => { if (p?.[0] === 8864 && /FROM drafts/.test(sql)) throw new Error('db hiccup'); return db.query(sql, p); };
    const recover = async (siteId) => { if (siteId === 8872) throw new Error('GitHub 502'); for (const d of db.drafts.filter((x) => x.site_id === siteId)) Object.assign(d, { status: 'pr_opened', pr_number: 5, pr_url: `https://x/${siteId}/pull/5` }); };
    const out = await consolidateDay({ sites, now: NOW, timezone: TZ, query: flaky, recover, log: () => {} });
    assert.equal(out.length, 6);
    assert.deepEqual(Object.fromEntries(out.map((r) => [r.siteId, r.outcome])), { 1: 'nothing-to-open', 8862: 'delivered', 8864: 'error', 8871: 'nothing-to-open', 8872: 'preserved', 8874: 'nothing-to-open' });
  });

  test('the preserved delivery reads as a plain, complete page', () => {
    const d = buildPreservedDelivery({ site: mkSite(8862), branch: 'action-center/batch-8862-2026-11-25', drafts: [{ id: 5, action_type: 'blog-outline', validation_status: 'passed', apply_error: 'PR failed' }], headSha: 'deadbeefcafe', exactError: 'GitHub 502 Bad Gateway', now: NOW });
    const md = renderPreservedDeliveryMarkdown(d);
    for (const must of ['Preserved delivery: Client 8862', 'action-center/batch-8862-2026-11-25', 'deadbeefca', 'GitHub 502 Bad Gateway', 'draft #5 blog-outline (validation: passed)', 'gh pr create', 'Retry PR', 'nothing needs regenerating']) assert.ok(md.includes(must), `missing: ${must}`);
  });
});

describe('the day close uses the preserved delivery, and waits for a pass that is still running', () => {
  test('preserved work is recorded with the exact error and the by-hand command', async () => {
    const db = fakeDb({ drafts: pushed(1, 2, { apply_error: 'rate limit' }) });
    const site = mkSite(1);
    const [c] = await consolidateDay({ sites: [site], now: NOW, timezone: TZ, query: db.query, recover: async () => { throw new Error('GitHub rate limit reached'); }, log: () => {} });
    assert.equal(c.outcome, 'preserved');
    const out = await closeDeliveryDay({ sites: [site], timezone: TZ, now: new Date('2026-11-25T11:15:00Z'), query: db.query });
    assert.equal(out[0].status, 'preserved');
    assert.match(out[0].blocker, /pull request could not be opened: GitHub rate limit reached/);
    assert.match(out[0].recovery, /gh pr create --repo Zunkireelabs\/web-1/);
  });

  test('a project still shipping at the close is deferred, then closed on the forced last run and marked as such', async () => {
    const db = fakeDb(); const site = mkSite(8872);
    const first = await closeDeliveryDay({ sites: [site], timezone: TZ, now: new Date('2026-11-25T11:15:00Z'), query: db.query, isInFlight: async () => true });
    assert.equal(first[0].status, 'deferred'); assert.equal(db.cycles[0].closed_at, null, 'not closed while its pass runs');
    const last = await closeDeliveryDay({ sites: [site], timezone: TZ, now: new Date('2026-11-25T11:35:00Z'), query: db.query, isInFlight: async () => true, force: true });
    assert.notEqual(last[0].status, 'deferred'); assert.ok(db.cycles[0].closed_at, 'the forced close closes it');
  });
});

describe('the deadline steps follow the window', () => {
  test('consolidation at 16:30, close at 17:00/17:10/17:20 (Nepal), the last one forced', () => {
    assert.equal(deliveryConsolidationCron(), '30 16 * * *');
    assert.equal(deliveryCloseCron(), '0,10,20 17 * * *');
    assert.equal(closeIsForced(TZ, new Date('2026-11-25T11:15:00Z')), false); // 17:00
    assert.equal(closeIsForced(TZ, new Date('2026-11-25T11:25:00Z')), false); // 17:10
    assert.equal(closeIsForced(TZ, new Date('2026-11-25T11:35:00Z')), true);  // 17:20
  });
});
