import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, createClientSite } from '../db.js';
import { provisionInstance, requestInstance, reconcileInstances, listInstancesNeedingAttention } from './agent-factory.js';

const TAG = `fac${Date.now()}`;
const ids = []; const wsIds = [];
async function mk(label, o = {}) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-${label}`])).rows[0].id; wsIds.push(ws);
  const connected = o.connected !== false;
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, onboarded_at) VALUES ($1,$2,$3,'UTC',$4,$5,$6) RETURNING id`,
    [`${TAG} ${label}`, connected ? `sc-${label}-${TAG}` : null, connected ? `g-${label}-${TAG}` : null, ws, `${label}.${TAG}.example`, o.onboarded === false ? null : new Date()])).rows[0].id;
  ids.push(id); return id;
}
// Real return shapes (see agent-factory.test.js).
const fakeDeps = (over = {}) => {
  const calls = { analyst: 0, snap: 0 };
  return { calls, deps: {
    ensureAnalystRegistered: async () => { calls.analyst++; return { status: 'already-registered' }; },
    assessTenantReadiness: async () => ({ siteId: 0, ready: true, items: [{ key: 'login', label: 'Client login', ok: true }], blocking: [] }),
    snapshotMemory: async () => { calls.snap++; },
    countMemoryVersions: async () => 0,
    ...over,
  } };
};
after(async () => {
  if (ids.length) { await query('DELETE FROM agent_instances WHERE site_id = ANY($1::int[])', [ids]); await query('DELETE FROM sites WHERE id = ANY($1::int[])', [ids]); }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('Agent Factory, real database', () => {
  test('creating a project records a requested instance, and touches nothing else', async () => {
    const s = await createClientSite({ name: `${TAG} created`, websiteDomain: `c.${TAG}.example`, timezone: 'UTC' });
    ids.push(s.id);
    const r = (await query('SELECT lifecycle_state, steps, last_error FROM agent_instances WHERE site_id = $1', [s.id])).rows[0];
    assert.equal(r.lifecycle_state, 'requested');
    assert.deepEqual(r.steps, {});
    assert.equal(r.last_error, null);
  });

  test('an unconnected project is "connecting" and says exactly what it waits for', async () => {
    const id = await mk('U', { connected: false });
    const { deps } = fakeDeps();
    const r = await provisionInstance(id, { deps });
    assert.equal(r.lifecycle, 'connecting');
    assert.equal(r.ok, true, 'waiting is not a failure');
    assert.ok(r.waitingFor.some((w) => w.step === 'analyst_client' && /connected/.test(w.detail)));
    assert.equal((await query('SELECT lifecycle_state FROM agent_instances WHERE site_id = $1', [id])).rows[0].lifecycle_state, 'connecting');
  });

  test('a connected, baselined project becomes active, gets a first memory version once, and is idempotent', async () => {
    const id = await mk('A');
    const f = fakeDeps();
    const first = await provisionInstance(id, { deps: f.deps });
    assert.equal(first.lifecycle, 'active');
    assert.equal(first.changed, true);
    assert.equal(f.calls.snap, 1);
    // second run: the memory now exists, so nothing changes
    const f2 = fakeDeps({ countMemoryVersions: async () => 1 });
    const second = await provisionInstance(id, { deps: f2.deps });
    assert.equal(second.changed, false);
    assert.equal(f2.calls.snap, 0);
    assert.equal((await query('SELECT count(*)::int n FROM agent_instances WHERE site_id = $1', [id])).rows[0].n, 1, 'still exactly one row');
  });

  test('a connected project awaiting its baseline is "baselining" and the baseline is NOT started', async () => {
    const id = await mk('B', { onboarded: false });
    let started = 0;
    const f = fakeDeps({ runBaseline: async () => { started++; return {}; } });
    const r = await provisionInstance(id, { deps: f.deps });
    assert.equal(r.lifecycle, 'baselining');
    assert.equal(started, 0);
    assert.ok(r.waitingFor.some((w) => w.step === 'baseline'));
  });

  test('a failing step is recorded, the other steps still run, and a retry recovers', async () => {
    const id = await mk('F');
    let fail = true;
    const f = fakeDeps({ ensureAnalystRegistered: async () => (fail ? { status: 'unreachable', error: 'connect ECONNREFUSED' } : { status: 'registered' }) });
    const bad = await provisionInstance(id, { deps: f.deps });
    assert.equal(bad.ok, false);
    assert.equal(bad.lifecycle, 'provisioning');
    assert.equal(bad.steps.analyst_client.status, 'failed');
    assert.equal(bad.steps.memory.status, 'ok', 'later independent steps still ran');
    const row = (await query('SELECT lifecycle_state, last_error FROM agent_instances WHERE site_id = $1', [id])).rows[0];
    assert.equal(row.lifecycle_state, 'provisioning');
    assert.match(row.last_error, /analyst_client/);
    fail = false;
    const good = await provisionInstance(id, { deps: f.deps });
    assert.equal(good.ok, true);
    assert.equal(good.lifecycle, 'active');
    assert.equal((await query('SELECT last_error FROM agent_instances WHERE site_id = $1', [id])).rows[0].last_error, null);
  });

  test('a step that throws is a failed step, not a crash', async () => {
    const id = await mk('T');
    const r = await provisionInstance(id, { deps: fakeDeps({ assessTenantReadiness: async () => { throw new Error('db down'); } }).deps });
    assert.equal(r.steps.readiness.status, 'failed');
    assert.equal(r.steps.schedule.status, 'ok');
  });

  test('an unknown project is "not found", and writes nothing', async () => {
    const r = await provisionInstance(999999999, { deps: fakeDeps().deps });
    assert.equal(r.found, false);
    assert.equal((await query('SELECT count(*)::int n FROM agent_instances WHERE site_id = 999999999')).rows[0].n, 0);
  });

  test('the factory only ever touches the project it was given', async () => {
    const a = await mk('IA'); const b = await mk('IB');
    const seen = [];
    const f = fakeDeps({ ensureAnalystRegistered: async (site) => { seen.push(site.id); return { status: 'already-registered' }; }, snapshotMemory: async (id) => { seen.push(id); } });
    await provisionInstance(a, { deps: f.deps });
    assert.deepEqual([...new Set(seen)], [a]);
    assert.equal((await query('SELECT count(*)::int n FROM agent_instances WHERE site_id = $1', [b])).rows[0].n, 0);
  });

  test('requestInstance is safe to repeat and never throws', async () => {
    const id = await mk('R');
    assert.equal(await requestInstance(id), true);
    assert.equal(await requestInstance(id), true);
    assert.equal(await requestInstance(999999999), false, 'a project that does not exist cannot get an instance, and that is not an error');
  });

  test('reconcile picks up projects needing attention, skips healthy ones, and one failure does not stop the rest', async () => {
    const good = await mk('RG'); const broken = await mk('RB');
    await provisionInstance(good, { deps: fakeDeps({ countMemoryVersions: async () => 1 }).deps });  // now active and fresh
    const before = await listInstancesNeedingAttention({ limit: 500 });
    assert.ok(!before.includes(good), 'a freshly reconciled active project is left alone');
    assert.ok(before.includes(broken), 'a project with no instance row yet needs it');
    const f = fakeDeps({ ensureAnalystRegistered: async (site) => { if (site.id === broken) throw new Error('boom'); return { status: 'already-registered' }; } });
    const out = await reconcileInstances({ deps: f.deps, limit: 500 });
    const mine = out.results.filter((r) => [good, broken].includes(r.siteId));
    assert.ok(mine.some((r) => r.siteId === broken), 'the broken one was attempted');
    assert.ok(out.checked >= 1);
  });
});
