import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { planDay } from './master-agent.js';
import { getSetting, setSetting, listChanges } from './platform-settings.js';
import {
  getMasterMode, clearMasterModeCache, loadReadiness, loadMasterControl, setMasterMode, shadowPlanDetail, recordPlanError, MasterControlError, MODE_KEY, PLAN_ERRORS_KEY,
} from './master-agent-control.js';

// Real Postgres. The projects are throwaway rows and every call that looks across projects is scoped to them (siteIds), so this file
// can share a database with the others. The two settings keys it writes are removed again at the end.
const TAG = `mc${Date.now()}`;
const ids = []; const wsIds = [];
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
async function mk(label) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-${label}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, onboarded_at, status) VALUES ($1,$2,$3,'UTC',$4,$5, now(), 'active') RETURNING id`,
    [`${TAG} ${label}`, `sc-${label}-${TAG}`, `g-${label}-${TAG}`, ws, `${label}.${TAG}.example`])).rows[0].id;
  ids.push(id); return id;
}
const wipe = async () => {
  await query(`DELETE FROM platform_settings WHERE key = ANY($1)`, [[MODE_KEY, PLAN_ERRORS_KEY]]);
  await query(`DELETE FROM platform_setting_changes WHERE key = ANY($1)`, [[MODE_KEY, PLAN_ERRORS_KEY]]);
  clearMasterModeCache();
};
before(wipe);
after(async () => {
  await wipe();
  if (ids.length) { await query('DELETE FROM instance_jobs WHERE site_id = ANY($1::int[])', [ids]); await query('DELETE FROM agent_runs WHERE site_id = ANY($1::int[])', [ids]); await query('DELETE FROM sites WHERE id = ANY($1::int[])', [ids]); }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('migration 246', () => {
  test('both tables exist with row level security on, and nothing is stored until someone chooses', async () => {
    const { rows } = await query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [['platform_setting_changes', 'platform_settings']]);
    assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity]), [['platform_setting_changes', true], ['platform_settings', true]]);
    assert.equal(await getMasterMode({ env: {} }), 'off', 'no row means off');
  });
});

describe('a setting and its history are one statement', () => {
  test('the first change has an empty from-value, the second remembers the first; history is newest first and names who did it', async () => {
    await setSetting(MODE_KEY, 'shadow', { by: null, email: 'first@x.test' });
    await setSetting(MODE_KEY, 'off', { by: null, email: 'second@x.test' });
    const h = await listChanges(MODE_KEY, { limit: 5 });
    assert.deepEqual(h.map((x) => [x.by, x.from, x.to]), [['second@x.test', 'shadow', 'off'], ['first@x.test', null, 'shadow']]);
    assert.equal((await getSetting(MODE_KEY)).value, 'off');
    await wipe();
  });
});

describe('the mode, read from the real table', () => {
  test('a stored choice is read at once after a change, and an env ceiling clamps it without touching the stored value', async () => {
    await setMasterMode('shadow', { email: 'a@x.test' });
    assert.equal(await getMasterMode({ env: {} }), 'shadow');
    assert.equal(await getMasterMode({ env: { MASTER_AGENT_MODE: 'off' } }), 'off');
    assert.equal((await getSetting(MODE_KEY)).value, 'shadow', 'the ceiling never rewrites the choice');
    await assert.rejects(setMasterMode('on', { env: { MASTER_AGENT_MODE: 'shadow' } }), (e) => e instanceof MasterControlError && e.code === 'CEILING');
    await wipe();
  });
});

describe('On is refused until Shadow has really run, then allowed (real instance_jobs)', () => {
  test('two planned shadow days are not enough; the third makes it ready; a failed plan takes it away again', async () => {
    await wipe();
    const a = await mk('A'); const b = await mk('B'); const scope = [a, b];
    await planDay({ mode: 'shadow', now: daysAgo(2), siteIds: scope });
    await planDay({ mode: 'shadow', now: daysAgo(1), siteIds: scope });
    let r = await loadReadiness({ siteIds: scope });
    assert.deepEqual([r.shadowDays, r.failedPlans, r.ready], [2, 0, false]);
    await assert.rejects(setMasterMode('on', { siteIds: scope }), (e) => e.code === 'NOT_READY' && /at least 3 days/.test(e.message));
    assert.equal((await getSetting(MODE_KEY)), null, 'a refused switch writes nothing');

    await planDay({ mode: 'shadow', now: new Date(), siteIds: scope });
    r = await loadReadiness({ siteIds: scope });
    assert.deepEqual([r.shadowDays, r.failedPlans, r.ready, r.migrationOk], [3, 0, true, true]);

    await recordPlanError({ day: daysAgo(1).toISOString().slice(0, 10), message: 'timed out' });
    r = await loadReadiness({ siteIds: scope });
    assert.deepEqual([r.failedPlans, r.ready], [1, false]);
    await assert.rejects(setMasterMode('on', { siteIds: scope }), (e) => e.code === 'NOT_READY' && /failed/.test(e.message));

    await query(`DELETE FROM platform_settings WHERE key = $1`, [PLAN_ERRORS_KEY]);
    const out = await setMasterMode('on', { siteIds: scope, by: null, email: 'admin@x.test' });
    assert.deepEqual([out.changed, out.from, out.to], [true, 'off', 'on']);
    assert.equal(await getMasterMode({ env: {} }), 'on');
    const c = await loadMasterControl({ env: {}, siteIds: scope });
    assert.equal(c.mode, 'on'); assert.deepEqual(c.history.map((h) => [h.by, h.from, h.to]), [['admin@x.test', 'off', 'on']]);
  });
  test('a project dropped from the plan fails the day it is missing', async () => {
    await wipe(); await query('DELETE FROM instance_jobs WHERE site_id = ANY($1::int[])', [ids]);
    const a = await mk('C'); const b = await mk('D'); const scope = [a, b];
    await planDay({ mode: 'shadow', now: daysAgo(2), siteIds: scope });
    await planDay({ mode: 'shadow', now: daysAgo(1), siteIds: [a] }); // b missing
    const r = await loadReadiness({ siteIds: scope });
    assert.equal(r.failedPlans, 1);
    assert.match(r.checks.find((c) => c.key === 'no-failed-plans').detail, /1 failed day/);
  });
});

describe('the plan compared with the existing run (real data)', () => {
  test('per-project order, names and times, and seven days of planned versus ran', async () => {
    await wipe(); await query('DELETE FROM instance_jobs WHERE site_id = ANY($1::int[])', [ids]);
    const a = await mk('E'); const b = await mk('F'); const scope = [a, b];
    await planDay({ mode: 'shadow', now: new Date(), siteIds: scope });
    // the existing loop ran project a today: 3 agent rows over a few seconds
    for (let i = 0; i < 3; i++) await query(`INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, took_ms, created_at) VALUES ($1,$2,1,'{}','ok',500, now() - ($3 || ' seconds')::interval)`, [a, `agent-${i}`, String((3 - i) * 5)]);
    const d = await shadowPlanDetail({ siteIds: scope });
    assert.equal(d.projects.length, 2);
    assert.deepEqual(d.projects.map((p) => p.order), [1, 2]);
    assert.ok(d.projects.every((p) => p.name.startsWith(TAG) && Number.isInteger(p.plannedMs) && p.plannedMs > 0));
    const pa = d.projects.find((p) => p.siteId === a); const pb = d.projects.find((p) => p.siteId === b);
    assert.ok(pa.legacyMs > 0, 'ran today, so a duration'); assert.equal(pb.legacyMs, null, 'did not run today, so null (not zero)');
    assert.equal(d.days.length, 7);
    const today = d.days[6];
    assert.deepEqual([today.planned, today.legacyRan], [2, 1]);
    assert.deepEqual(d.days.slice(0, 6).map((x) => x.planned), [0, 0, 0, 0, 0, 0]);
  });
});
