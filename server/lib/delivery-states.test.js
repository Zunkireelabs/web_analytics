import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleOf, summarizeLifecycle, LIFECYCLE } from './delivery-lifecycle.js';
import { evaluateAlerts, newAlerts, HUNG_LOCK_HOURS } from './delivery-alerts.js';
import { loadDeliveryStatus } from './delivery-status.js';
import { resetSessionStateForTests } from './worker-session.js';

const NOW = new Date('2026-11-25T11:45:00Z'); // 17:30 Nepal: after the last close
const TZ = 'Asia/Kathmandu';
const D = (o = {}) => ({ id: 1, site_id: 8864, pr_number: 70, pr_state: 'open', status: 'pr_opened', merged_at: null, merged_by: null, merged_by_type: null, production_verified_at: null, ...o });

describe('three separate facts: pr_opened, human_merged, production_verified', () => {
  test('each state is only what was recorded, nothing inferred', () => {
    assert.equal(lifecycleOf(D({ pr_number: null })), LIFECYCLE.NO_PR);
    assert.equal(lifecycleOf(D()), LIFECYCLE.PR_OPENED);
    assert.equal(lifecycleOf(D({ pr_state: 'closed', status: 'abandoned' })), LIFECYCLE.PR_CLOSED);
    assert.equal(lifecycleOf(D({ merged_at: '2026-11-25T05:00:00Z', merged_by: 'sthasadin', merged_by_type: 'User' })), LIFECYCLE.HUMAN_MERGED);
    assert.equal(lifecycleOf(D({ merged_at: '2026-11-25T05:00:00Z', merged_by: 'superrank-app[bot]', merged_by_type: 'Bot' })), LIFECYCLE.MERGED_BY_BOT);
    assert.equal(lifecycleOf(D({ merged_at: '2026-11-25T05:00:00Z' })), LIFECYCLE.MERGED_UNATTRIBUTED, 'merged before who-merged was recorded: said so, not assumed human');
    assert.equal(lifecycleOf(D({ merged_at: '2026-11-25T05:00:00Z', merged_by_type: 'User', production_verified_at: '2026-11-26T05:00:00Z' })), LIFECYCLE.PRODUCTION_VERIFIED);
  });
  test('a merge alone is never "production verified", and verification without a merge is not a state', () => {
    assert.notEqual(lifecycleOf(D({ merged_at: 'x', merged_by_type: 'User' })), LIFECYCLE.PRODUCTION_VERIFIED);
    assert.equal(lifecycleOf(D({ production_verified_at: 'x' })), LIFECYCLE.PR_OPENED, 'no merge on record: still just an open PR');
  });
  test('the summary counts every state and lists what needs attention', () => {
    const old = '2026-11-20T00:00:00Z';
    const s = summarizeLifecycle([D({ id: 1 }), D({ id: 2, merged_at: old, merged_by: 'a', merged_by_type: 'User' }), D({ id: 3, merged_at: old, merged_by: 'bot', merged_by_type: 'Bot' }), D({ id: 4, merged_at: old, merged_by_type: 'User', production_verified_at: old }), D({ id: 5, pr_number: null })], { now: NOW });
    assert.deepEqual([s.counts.pr_opened, s.counts.human_merged, s.counts.merged_by_bot, s.counts.production_verified, s.counts.no_pr], [1, 1, 1, 1, 1]);
    assert.deepEqual(s.mergedUnverified.map((d) => d.id), [2]); assert.deepEqual(s.mergedBot.map((d) => d.id), [3]); assert.deepEqual(s.waitingForReview.map((d) => d.id), [1]);
  });
});

describe('alerts: the silent failures are said out loud', () => {
  const sites = [1, 8862, 8864, 8871, 8872, 8874].map((id) => ({ id, name: `Client ${id}` }));
  const closed = (site_id, extra = {}) => ({ site_id, status: 'no-work', closed_at: '2026-11-25T11:35:00Z', stages: {}, ...extra });
  const keys = (a) => a.map((x) => x.key).sort();

  test('after the deadline every project without a closed record is a CRITICAL alert (nobody may disappear from a day)', () => {
    const a = evaluateAlerts({ now: NOW, timezone: TZ, sites, cycles: [closed(1), closed(8862), closed(8864), { site_id: 8871, status: 'open', closed_at: null, stages: {} }] });
    assert.deepEqual(keys(a.filter((x) => x.key.startsWith('missing-record'))), ['missing-record:8871', 'missing-record:8872', 'missing-record:8874']);
    assert.ok(a.filter((x) => x.key.startsWith('missing-record')).every((x) => x.severity === 'critical'));
  });
  test('before the last close nothing is called missing yet', () => {
    assert.equal(evaluateAlerts({ now: new Date('2026-11-25T08:00:00Z'), timezone: TZ, sites, cycles: [] }).filter((x) => x.key.startsWith('missing-record')).length, 0);
  });
  test('preserved work, an unreached project and a forced close each raise their own alert with the recorded reason', () => {
    const a = evaluateAlerts({ now: NOW, timezone: TZ, sites, cycles: sites.map((s) => closed(s.id)).map((c) => (c.site_id === 1 ? { ...c, status: 'preserved', blocker: 'PR could not be opened: rate limit', recovery: 'Open the PR from the branch.' } : c.site_id === 8872 ? { ...c, status: 'unreached', blocker: 'window-closed' } : c.site_id === 8874 ? { ...c, stages: { closed: { forced: true } } } : c)) });
    assert.deepEqual(keys(a), ['in-flight-at-close:8874', 'preserved:1', 'unreached:8872']);
    assert.equal(a.find((x) => x.key === 'preserved:1').severity, 'high'); assert.match(a.find((x) => x.key === 'preserved:1').message, /rate limit/);
  });
  test('a lock held for hours is a hung lock; a lock that already expired, or a short one, is not', () => {
    const at = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const a = evaluateAlerts({ now: NOW, timezone: TZ, sites: [], locks: [
      { job_key: 'daily-job:all-sites', acquired_at: at(5.3), heartbeat_at: at(0.1), expires_at: new Date(NOW.getTime() + 600_000).toISOString() },
      { job_key: 'short', acquired_at: at(1), heartbeat_at: at(0), expires_at: new Date(NOW.getTime() + 600_000).toISOString() },
      { job_key: 'expired', acquired_at: at(9), heartbeat_at: at(8), expires_at: at(7) },
    ] });
    assert.deepEqual(keys(a), ['hung-lock:daily-job:all-sites']); assert.match(a[0].message, /5\.3 hours/); assert.ok(HUNG_LOCK_HOURS >= 1);
  });
  test('a merge by an app account is CRITICAL (this system never merges); a person merging and not verified is a warning', () => {
    const a = evaluateAlerts({ now: NOW, timezone: TZ, sites, cycles: sites.map((s) => closed(s.id)), mergedByBot: [{ site_id: 8864, pr_number: 70, merged_by: 'superrank[bot]', merged_by_type: 'Bot' }], mergedUnverified: [{ site_id: 8862, pr_number: 137, merged_by: 'sthasadin' }] });
    assert.equal(a.find((x) => x.key === 'merged-by-bot:8864:70').severity, 'critical');
    assert.equal(a.find((x) => x.key === 'merged-unverified:8862:137').severity, 'warning');
  });
  test('the worker offline for half an hour inside the window raises one alert; outside the window it does not', () => {
    const ticks = [{ why: 'worker-offline', count: 8, firstAt: '2026-11-25T05:00:00Z', lastAt: '2026-11-25T05:40:00Z' }];
    assert.equal(evaluateAlerts({ now: new Date('2026-11-25T05:45:00Z'), timezone: TZ, sites: [], skippedTicks: ticks }).some((x) => x.key === 'worker-offline'), true);
    assert.equal(evaluateAlerts({ now: new Date('2026-11-25T14:00:00Z'), timezone: TZ, sites: [], skippedTicks: ticks }).some((x) => x.key === 'worker-offline'), false);
  });
  test('an alert is stated once: newAlerts drops what was already sent today', () => {
    const all = [{ key: 'a' }, { key: 'b' }];
    assert.deepEqual(newAlerts(all, new Set(['a'])), [{ key: 'b' }]);
  });
});

describe('the status view reads the day for every project', () => {
  test('one entry per project with the closed record, item counts, preserved delivery text, lifecycle counts and the alerts', async () => {
    resetSessionStateForTests();
    const cycles = [
      { id: 11, site_id: 8864, cycle_date: '2026-11-25', status: 'delivered', closed_at: '2026-11-25T11:20:00Z', passes: 3, attempted: 8, shipped: 1, blocked: 10, skipped: 10, pr_url: 'https://github.com/x/pull/70', branch_name: 'action-center/batch-8864-2026-11-25', stages: {} },
      { id: 12, site_id: 1, cycle_date: '2026-11-25', status: 'preserved', closed_at: '2026-11-25T11:20:00Z', passes: 4, attempted: 29, shipped: 0, blocked: 10, skipped: 56, blocker: 'PR could not be opened: rate limit', recovery: 'gh pr create ...', stages: { delivery: { site: { id: 1, name: 'Client 1' }, branch: 'action-center/batch-1-2026-11-25', headSha: 'abc', itemCount: 2, items: [{ draftId: 5, actionType: 'faq' }], exactError: 'rate limit', recovery: { automatic: 'retried hourly', byHand: ['gh pr create ...'], nothingLost: 'nothing needs regenerating' } } } },
    ];
    const items = [{ cycle_id: 11, state: 'blocked', recommendation_id: 9, content_draft_id: 3, generator_id: 'blog-outline', page: '/blog/x', blocked_kind: 'FAILED_BECAUSE_INPUT_IS_INVALID', blocked_reason: 'held', retry_policy: 'needs_human' }, { cycle_id: 11, state: 'shipped' }];
    const query = async (sql) => {
      if (/FROM delivery_cycles WHERE site_id/.test(sql)) return { rows: cycles };
      if (/FROM delivery_items/.test(sql)) return { rows: items };
      if (/FROM job_locks/.test(sql)) return { rows: [] };
      if (/FROM drafts WHERE site_id/.test(sql)) return { rows: [D({ id: 70, site_id: 8864, merged_at: '2026-11-25T08:00:00Z', merged_by: 'sthasadin', merged_by_type: 'User' })] };
      throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
    };
    const status = await loadDeliveryStatus({ sites: [{ id: 1, name: 'Client 1' }, { id: 8864, name: 'Chayce' }, { id: 8874, name: 'MOBILISE' }], now: NOW, timezone: TZ, query });
    assert.equal(status.sites.length, 3, 'every project appears, even the one with no record');
    const chayce = status.sites.find((s) => s.siteId === 8864);
    assert.deepEqual([chayce.today.status, chayce.today.prUrl, chayce.today.items], ['delivered', 'https://github.com/x/pull/70', { blocked: 1, shipped: 1 }]);
    assert.equal(chayce.today.blockedItems[0].generator, 'blog-outline'); assert.equal(chayce.lifecycle.human_merged, 1);
    const c1 = status.sites.find((s) => s.siteId === 1);
    assert.match(c1.today.preservedDelivery.markdown, /Preserved delivery: Client 1/); assert.match(c1.today.preservedDelivery.markdown, /gh pr create/);
    assert.equal(status.sites.find((s) => s.siteId === 8874).today, null);
    assert.ok(status.alerts.some((a) => a.key === 'missing-record:8874'), 'the project with no record is raised as an alert');
    assert.ok(status.alerts.some((a) => a.key === 'preserved:1'));
  });
});

// The three states against a REAL Postgres: the throwaway srtest database only.
const LOCAL = /@(localhost|127\.0\.0\.1):55432\/srtest/.test(process.env.DATABASE_URL || '');
describe('merge and verification states in a real database (migration 271)', { skip: !LOCAL }, () => {
  test('who merged is recorded once, a Bot merge is detectable, and only a verified-fixed outcome sets production_verified', async () => {
    const db = await import('../db.js'); const drafts = await import('../store/drafts.js'); const fv = await import('../store/fix-verifications.js');
    const { rows: [site] } = await db.query('SELECT id FROM sites ORDER BY id LIMIT 1');
    const mk = async (pr) => (await db.query(`INSERT INTO drafts (site_id, action_type, input, content, status, pr_number, pr_url, pr_state, branch_name) VALUES ($1,'faq','{}','{}','pr_opened',$2,$3,'open','action-center/batch-test') RETURNING id`, [site.id, pr, `https://github.com/x/pull/${pr}`])).rows[0].id;
    const human = await mk(9001); const bot = await mk(9002);
    try {
      await drafts.recordPrMerge(site.id, human, { mergedBy: 'sthasadin', mergedByType: 'User', mergedAt: '2026-11-25T05:00:00Z' });
      await drafts.recordPrMerge(site.id, human, { mergedBy: 'someone-else', mergedByType: 'Bot', mergedAt: '2026-11-26T05:00:00Z' });
      await drafts.recordPrMerge(site.id, bot, { mergedBy: 'superrank[bot]', mergedByType: 'Bot' });
      const row = async (id) => (await db.query('SELECT * FROM drafts WHERE id = $1', [id])).rows[0];
      assert.deepEqual([(await row(human)).merged_by, (await row(human)).merged_by_type], ['sthasadin', 'User'], 'first write wins: a later poll never rewrites who merged');
      assert.equal(lifecycleOf(await row(human)), 'human_merged'); assert.equal(lifecycleOf(await row(bot)), 'merged_by_bot');
      const { rows: [v] } = await db.query(`INSERT INTO fix_verifications (site_id, finding_id, draft_id, generator_id, verify_after) VALUES ($1,'f-test',$2,'faq', now()) RETURNING id`, [site.id, human]);
      await fv.recordVerificationOutcome(v.id, 'still-present', {});
      assert.equal((await row(human)).production_verified_at, null, 'a failed verification does not verify');
      await fv.recordVerificationOutcome(v.id, 'verified-fixed', {});
      assert.ok((await row(human)).production_verified_at, 'verified-fixed on the live page sets it');
      assert.equal(lifecycleOf(await row(human)), 'production_verified');
      assert.equal((await row(bot)).production_verified_at, null);
    } finally { await db.query(`DELETE FROM fix_verifications WHERE draft_id = ANY($1::int[])`, [[human, bot]]); await db.query(`DELETE FROM drafts WHERE id = ANY($1::int[])`, [[human, bot]]); await db.pool?.end?.(); }
  });
});
