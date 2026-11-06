import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// GET /product runs against the REAL store, the REAL behaviourModel (report/doc-model.js) and the REAL role lookup, with
// real fixture rows: the shapes are what the Overview actually receives, and "who may connect" is the same decision the
// connect routes make, not a stand-in for it.
process.env.COMPANY_SITE_ID = '1';

const { pool, query } = await import('../db.js');
const store = await import('../store/project-posthog.js');
const router = (await import('./metrics.js')).default;

const userIds = [];
// A real person with a real role on a project. role = null means no relationship to it at all.
async function personOn(siteId, role) {
  const stamp = `metrics-product-${Date.now()}-${Math.floor(Math.random() * 1e9)}@fixture.test`;
  const { rows } = await query("INSERT INTO users (site_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id", [siteId, stamp, role === 'admin' ? 'tenant_admin' : 'tenant_member']);
  userIds.push(rows[0].id);
  if (role) await query('INSERT INTO project_members (site_id, user_id, role) VALUES ($1, $2, $3)', [siteId, rows[0].id, role]);
  return rows[0].id;
}
const siteIds = []; const workspaceIds = [];
async function makeSite(label) {
  const stamp = `metrics-product-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // Every real project lives in a workspace; without one the access decision takes the legacy path, which has no roles.
  const ws = await query(`INSERT INTO workspaces (name) VALUES ('metrics.product.test.js fixture') RETURNING id`);
  workspaceIds.push(ws.rows[0].id);
  const { rows } = await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id) VALUES ('metrics.product.test.js fixture', $1, $2, 'UTC', $3) RETURNING id`, [stamp, stamp, ws.rows[0].id]);
  siteIds.push(rows[0].id);
  return rows[0].id;
}
async function get(siteId, q, userId) {
  const layer = router.stack.find((l) => l.route?.path === '/product' && l.route.methods.get);
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle({ siteId, userId, query: q }, res, (e) => { if (e) throw e; });
  return res;
}
const connect = async (siteId, { project = true, status = 'ok' } = {}) => {
  await store.saveOauthSignIn(siteId, { host: 'https://us.posthog.com', clientId: 'https://app.superrank.si/api/posthog/oauth-client', tokens: { accessToken: 'pha_secret', refreshToken: 'phr_secret', expiresAt: new Date(Date.now() + 3600_000), scopes: ['query:read', 'project:read'] }, email: 'maya@brightsmile.com' });
  if (project) { await store.selectOauthProject(siteId, { projectId: '4521', projectName: 'BrightSmile' }); await store.recordPosthogStatus(siteId, status === 'ok', status === 'ok' ? null : 'broken'); }
};

let savedKey;
before(() => { savedKey = process.env.SECRETS_ENCRYPTION_KEY; process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64'); });
after(async () => {
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  if (userIds.length) await query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  if (workspaceIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [workspaceIds]);
  await pool.end();
});

const day = (siteId, date, over = {}) => store.upsertPosthogDay(siteId, {
  date, totals: { events: 1000, people: 90, pageviews: 400, sessions: 200 },
  dropOffs: [{ event: 'page: /pricing', sessionsEndingHere: 60 }, { event: 'booking_form_started', sessionsEndingHere: 30 }],
  topActions: [{ label: 'Clicked “Book now”', raw: null, times: 40 }], ...over,
});

describe('GET /product', () => {
  test('a project member with data gets numbers, state, series AND the same behaviour card the reports use', async () => {
    const siteId = await makeSite('data');
    await connect(siteId); await day(siteId, '2026-11-01'); await day(siteId, '2026-11-02');
    const { body } = await get(siteId, { start: '2026-11-01', end: '2026-11-02' }, await personOn(siteId, 'admin'));
    assert.equal(body.connected, true); assert.equal(body.status, 'ok'); assert.equal(body.canConnect, true);
    assert.equal(body.summary.sessions, 400); assert.equal(body.summary.pageviews, 800);
    assert.deepEqual(body.series.map((p) => p.date), ['2026-11-01', '2026-11-02']);
    assert.deepEqual(body.series, body.summary.series);
    assert.equal(body.summary.topActions[0].times, 80);
    assert.equal(body.behaviour.visits, 400);
    assert.deepEqual(body.behaviour.stops.map((s) => [s.label, s.n, s.share]), [['The /pricing page', 120, 30], ['Booking form started', 60, 15]]);
    assert.ok(body.behaviour.takeaway);
    const text = JSON.stringify(body);
    for (const secret of ['pha_secret', 'phr_secret']) assert.ok(!text.includes(secret), 'no token may appear in this response');
  });

  test('a read-only member sees exactly the same data, and is told they cannot connect — never a 403', async () => {
    const siteId = await makeSite('readonly');
    await connect(siteId); await day(siteId, '2026-11-01');
    const res = await get(siteId, { start: '2026-11-01', end: '2026-11-01' }, await personOn(siteId, 'member'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canConnect, false); assert.equal(res.body.connected, true); assert.equal(res.body.summary.sessions, 200);
  });

  test('not connected is a normal state: no summary, no behaviour, empty series, can connect if admin', async () => {
    const siteId = await makeSite('none');
    const { body } = await get(siteId, { start: '2026-11-01', end: '2026-11-02' }, await personOn(siteId, 'admin'));
    assert.deepEqual([body.summary, body.connected, body.status, body.behaviour, body.series, body.canConnect], [null, false, null, null, [], true]);
  });

  test('connected but nothing imported yet is distinguishable from not connected', async () => {
    const siteId = await makeSite('backfilling');
    await connect(siteId);
    await store.recordPosthogStatus(siteId, true); // status ok, no data in range
    const { body } = await get(siteId, { start: '2026-11-01', end: '2026-11-02' }, await personOn(siteId, 'admin'));
    assert.deepEqual([body.summary, body.connected, body.status, body.behaviour], [null, true, 'ok', null]);
  });

  test('signed in but no project chosen yet is NOT connected', async () => {
    const siteId = await makeSite('pending');
    await connect(siteId, { project: false });
    const { body } = await get(siteId, { start: '2026-11-01', end: '2026-11-02' }, await personOn(siteId, 'admin'));
    assert.deepEqual([body.connected, body.status], [false, null]);
  });

  test('a broken connection says so (the Overview offers to reconnect)', async () => {
    const siteId = await makeSite('broken');
    await connect(siteId, { status: 'error' }); await day(siteId, '2026-11-01');
    assert.equal((await get(siteId, { start: '2026-11-01', end: '2026-11-01' }, await personOn(siteId, 'admin'))).body.status, 'error');
  });

  test('the previous period is the same call on the other range, and the two never mix', async () => {
    const siteId = await makeSite('previous');
    await connect(siteId);
    await day(siteId, '2026-10-01', { totals: { events: 10, people: 5, pageviews: 20, sessions: 10 } });
    await day(siteId, '2026-11-01');
    const who = await personOn(siteId, 'admin');
    const cur = (await get(siteId, { start: '2026-11-01', end: '2026-11-01' }, who)).body;
    const prev = (await get(siteId, { start: '2026-10-01', end: '2026-10-01' }, who)).body;
    assert.deepEqual([cur.summary.sessions, prev.summary.sessions], [200, 10]);
    assert.equal(prev.series.length, 1);
  });

  test('a failing role lookup never fails the request: the person just cannot connect', async () => {
    const siteId = await makeSite('rolefail');
    await connect(siteId); await day(siteId, '2026-11-01');
    for (const who of ['not-a-number', await personOn(siteId, null)]) { // a lookup that throws, and a person with no role here
      const res = await get(siteId, { start: '2026-11-01', end: '2026-11-01' }, who);
      assert.equal(res.statusCode, 200); assert.equal(res.body.canConnect, false); assert.equal(res.body.connected, true);
    }
  });
});
