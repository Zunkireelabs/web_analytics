import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, STEP_ORDER, lifecycleFrom } from './agent-factory.js';
import { deriveLifecycle, isSchedulable, LIFECYCLE } from './instance-lifecycle.js';

const site = (o = {}) => ({ id: 1, status: 'active', workspace_id: 5, gsc_property: 'sc', ga4_property_id: 'g', onboarded_at: '2026-10-01', growth_started_at: '2026-10-01', property_type: 'website', ...o });
// REAL shapes. ensureAnalystRegistered returns { status: 'already-registered'|'registered'|'unreachable'|'failed'|'skipped', error? };
// assessTenantReadiness returns { siteId, ready, items: [{ key, label, ok, detail, fix }], blocking } (lib/tenant-provisioning.js).
const readinessOf = (items) => async () => ({ siteId: 1, ready: items.every((i) => i.ok !== false), items, blocking: items.filter((i) => i.ok === false) });

describe('lifecycle rule', () => {
  test('each state', () => {
    assert.equal(deriveLifecycle(site({ status: 'soft_deleted' })), 'removed');
    assert.equal(deriveLifecycle(site({ status: 'suspended' })), 'paused');
    assert.equal(deriveLifecycle(site({ gsc_property: null })), 'connecting');
    assert.equal(deriveLifecycle(site({ onboarded_at: null })), 'baselining');
    assert.equal(deriveLifecycle(site()), 'active');
    assert.equal(deriveLifecycle(null), 'removed');
    for (const s of ['removed', 'paused', 'connecting', 'baselining', 'active']) assert.ok(LIFECYCLE.includes(s));
  });
  test('a product project needs no Google connection or baseline to be active', () => {
    assert.equal(deriveLifecycle(site({ property_type: 'product', gsc_property: null, ga4_property_id: null, onboarded_at: null })), 'active');
    assert.equal(isSchedulable(site({ property_type: 'product', gsc_property: null })), true);
  });
  test('schedulable means active and connected', () => {
    assert.equal(isSchedulable(site()), true);
    assert.equal(isSchedulable(site({ ga4_property_id: null })), false);
    assert.equal(isSchedulable(site({ status: 'suspended' })), false);
  });
  test('the rule equals the scheduler\'s own (job.js listConnectedSites)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../job.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function listConnectedSites'), src.indexOf('export async function runDailyJobForAllSites'));
    assert.match(body, /s\.status !== 'active'\) return false/);
    assert.match(body, /s\.property_type === 'product'\) return true/);
    assert.match(body, /Boolean\(s\.gsc_property && s\.ga4_property_id\)/);
  });
  test('a failed step holds an otherwise active project in provisioning; pending steps do not', () => {
    assert.equal(lifecycleFrom(site(), { a: { status: 'failed' } }), 'provisioning');
    assert.equal(lifecycleFrom(site(), { a: { status: 'pending' } }), 'active');
    assert.equal(lifecycleFrom(site({ gsc_property: null }), { a: { status: 'failed' } }), 'connecting');
  });
});

describe('steps', () => {
  const ctx = (s, deps = {}, extra = {}) => ({ site: s, deps, autoBaseline: false, ...extra });
  test('the order is fixed and every step exists', () => {
    for (const k of STEP_ORDER) assert.equal(typeof STEPS[k], 'function', k);
  });
  test('identity', async () => {
    assert.equal((await STEPS.identity(ctx(site()))).status, 'ok');
    assert.equal((await STEPS.identity(ctx(site({ workspace_id: null })))).status, 'pending');
    assert.equal((await STEPS.identity(ctx(site({ status: 'suspended' })))).status, 'pending');
    assert.equal((await STEPS.identity(ctx(site({ status: 'soft_deleted' })))).status, 'skipped');
  });
  test('analyst: waits for connection, registers once, reports the real statuses', async () => {
    let calls = 0;
    const deps = (status, error) => ({ ensureAnalystRegistered: async () => { calls++; return { status, error }; } });
    assert.equal((await STEPS.analyst_client(ctx(site({ gsc_property: null }), deps('registered')))).status, 'pending');
    assert.equal(calls, 0, 'not called for an unconnected project');
    assert.equal((await STEPS.analyst_client(ctx(site(), deps('already-registered')))).status, 'ok');
    const made = await STEPS.analyst_client(ctx(site(), deps('registered')));
    assert.deepEqual([made.status, made.changed], ['ok', true]);
    for (const bad of ['unreachable', 'failed']) assert.equal((await STEPS.analyst_client(ctx(site(), deps(bad, 'boom')))).status, 'failed');
  });
  test('readiness lists exactly what is missing', async () => {
    const items = [{ key: 'login', label: 'Client login', ok: true }, { key: 'analyst', label: 'Data Analyst client', ok: false }, { key: 'x', label: 'N/A', ok: null }];
    const r = await STEPS.readiness(ctx(site(), { assessTenantReadiness: readinessOf(items) }));
    assert.equal(r.status, 'pending');
    assert.deepEqual(r.missing, ['Data Analyst client']);
    assert.equal((await STEPS.readiness(ctx(site(), { assessTenantReadiness: readinessOf([items[0]]) }))).status, 'ok');
  });
  test('baseline is never started unless asked, and says what it is waiting for', async () => {
    let started = 0;
    const deps = { runBaseline: async () => { started++; return {}; } };
    assert.equal((await STEPS.baseline(ctx(site({ onboarded_at: null }), deps))).status, 'pending');
    assert.equal(started, 0, 'the costly baseline must not start by itself');
    assert.match((await STEPS.baseline(ctx(site({ onboarded_at: null, gsc_property: null }), deps))).detail, /connected/);
    assert.equal((await STEPS.baseline(ctx(site(), deps))).status, 'ok');
    assert.equal((await STEPS.baseline(ctx(site({ onboarded_at: null }), deps, { autoBaseline: true }))).status, 'ok');
    assert.equal(started, 1);
    assert.equal((await STEPS.baseline(ctx(site({ onboarded_at: null }), { runBaseline: async () => ({ error: 'google said no' }) }, { autoBaseline: true }))).status, 'failed');
    assert.equal((await STEPS.baseline(ctx(site({ property_type: 'product', onboarded_at: null }), deps))).status, 'skipped');
  });
  test('memory: records the first version only when there is none', async () => {
    let snaps = 0;
    const mk = (n) => ({ countMemoryVersions: async () => n, snapshotMemory: async () => { snaps++; } });
    assert.equal((await STEPS.memory(ctx(site(), mk(3)))).status, 'ok');
    assert.equal(snaps, 0);
    const first = await STEPS.memory(ctx(site(), mk(0)));
    assert.deepEqual([first.status, first.changed, snaps], ['ok', true, 1]);
    assert.equal((await STEPS.memory(ctx(site({ gsc_property: null }), mk(0)))).status, 'pending');
  });
});
