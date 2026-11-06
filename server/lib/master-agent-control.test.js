import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  envCeiling, clampMode, getMasterMode, clearMasterModeCache, evaluateShadowDays, loadReadiness, loadMasterControl, setMasterMode,
  recordPlanError, MasterControlError, REQUIRED_SHADOW_DAYS, MODE_KEY, PLAN_ERRORS_KEY,
} from './master-agent-control.js';

// A fake `query` that answers only the statements these functions make, from plain in-memory state, and records every write.
function fake({ stored, jobs = [], sites = [], changes = [], planErrors = null, tables = { jobs: true, settings: true } } = {}) {
  const f = { writes: [], reads: 0 };
  f.query = async (sql, params) => {
    f.reads++;
    if (/INSERT INTO platform_setting_changes/.test(sql) && /WITH old/.test(sql)) { f.writes.push({ key: params[0], value: JSON.parse(params[1]), by: params[2], email: params[3] }); stored = JSON.parse(params[1]); return { rows: [{ id: 1 }] }; }
    if (/INSERT INTO platform_settings/.test(sql)) { f.writes.push({ quiet: true, key: params[0], value: JSON.parse(params[1]) }); return { rows: [] }; }
    if (/FROM platform_settings WHERE key/.test(sql)) {
      if (params[0] === PLAN_ERRORS_KEY) return { rows: planErrors ? [{ value: planErrors }] : [] };
      if (params[0] === MODE_KEY) return { rows: stored === undefined ? [] : [{ value: stored, updated_by: 1, updated_at: new Date() }] };
    }
    if (/FROM platform_setting_changes/.test(sql)) return { rows: changes };
    if (/FROM instance_jobs/.test(sql)) return { rows: jobs };
    if (/FROM sites WHERE status = 'active'/.test(sql)) return { rows: sites };
    if (/to_regclass/.test(sql)) return { rows: [tables] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  };
  return f;
}
const site = (id) => ({ id, status: 'active', gsc_property: 'g', ga4_property_id: 'a' });
const NOW = new Date('2026-11-06T12:00:00Z');
const job = (day, site_id, odd = false) => ({ day, site_id, odd });

beforeEach(() => clearMasterModeCache());

describe('the env ceiling', () => {
  test('unset is no ceiling; a real mode is itself; junk fails closed to off', () => {
    assert.equal(envCeiling({}), null);
    assert.equal(envCeiling({ MASTER_AGENT_MODE: '' }), null);
    assert.equal(envCeiling({ MASTER_AGENT_MODE: ' SHADOW ' }), 'shadow');
    assert.equal(envCeiling({ MASTER_AGENT_MODE: 'on' }), 'on');
    assert.equal(envCeiling({ MASTER_AGENT_MODE: 'banana' }), 'off');
  });
  test('clamping never raises a mode, only lowers it', () => {
    assert.equal(clampMode('on', 'shadow'), 'shadow');
    assert.equal(clampMode('on', 'off'), 'off');
    assert.equal(clampMode('shadow', 'on'), 'shadow');
    assert.equal(clampMode('off', 'shadow'), 'off');
    assert.equal(clampMode('on', null), 'on');
  });
});

describe('getMasterMode', () => {
  test('no stored choice is off', async () => {
    assert.equal(await getMasterMode({ query: fake({}).query, env: {} }), 'off');
  });
  test('the stored choice is used, and an env ceiling clamps it', async () => {
    assert.equal(await getMasterMode({ query: fake({ stored: 'on' }).query, env: {} }), 'on');
    assert.equal(await getMasterMode({ query: fake({ stored: 'on' }).query, env: { MASTER_AGENT_MODE: 'shadow' } }), 'shadow');
    assert.equal(await getMasterMode({ query: fake({ stored: 'shadow' }).query, env: { MASTER_AGENT_MODE: 'on' } }), 'shadow');
  });
  test('a ceiling of off needs no database read at all', async () => {
    const f = fake({ stored: 'on' });
    assert.equal(await getMasterMode({ query: f.query, env: { MASTER_AGENT_MODE: 'off' } }), 'off');
    assert.equal(f.reads, 0);
  });
  test('an unreadable database is off, never an error and never a guess', async () => {
    const q = async () => { throw new Error('connection refused'); };
    assert.equal(await getMasterMode({ query: q, env: {} }), 'off');
  });
  test('a junk stored value is off', async () => {
    assert.equal(await getMasterMode({ query: fake({ stored: 'turbo' }).query, env: {} }), 'off');
  });
});

describe('which shadow days failed', () => {
  const S = new Set([1, 2, 3]);
  test('three clean days, every project every day: nothing failed', () => {
    const rows = ['2026-11-01', '2026-11-02', '2026-11-03'].flatMap((d) => [1, 2].map((id) => job(d, id)));
    const ev = evaluateShadowDays(rows, S);
    assert.deepEqual(ev.shadowDays, ['2026-11-01', '2026-11-02', '2026-11-03']);
    assert.deepEqual(ev.failedDays, []);
  });
  test('a project planned earlier and missing later fails that day', () => {
    const rows = [job('2026-11-01', 1), job('2026-11-01', 2), job('2026-11-02', 1)];
    assert.deepEqual(evaluateShadowDays(rows, S).failedDays, ['2026-11-02']);
  });
  test('a project that is no longer schedulable does not make a day fail', () => {
    const rows = [job('2026-11-01', 1), job('2026-11-01', 9), job('2026-11-02', 1)];
    assert.deepEqual(evaluateShadowDays(rows, S).failedDays, []);
  });
  test('a project connected later is not "missing" from days before it existed', () => {
    const rows = [job('2026-11-01', 1), job('2026-11-02', 1), job('2026-11-02', 2)];
    assert.deepEqual(evaluateShadowDays(rows, S).failedDays, []);
  });
  test('a planned row that is not an untouched shadow row fails its day', () => {
    assert.deepEqual(evaluateShadowDays([job('2026-11-01', 1, true)], S).failedDays, ['2026-11-01']);
  });
  test('a recorded plan error fails its day even when no rows were written, and is not a shadow day', () => {
    const ev = evaluateShadowDays([job('2026-11-01', 1)], S, { '2026-11-02': 'boom' });
    assert.deepEqual(ev.failedDays, ['2026-11-02']);
    assert.deepEqual(ev.shadowDays, ['2026-11-01']);
  });
  test('days before the window start are ignored', () => {
    const ev = evaluateShadowDays([job('2026-10-01', 1, true)], S, { '2026-10-02': 'old' }, { from: '2026-11-01' });
    assert.deepEqual([ev.shadowDays, ev.failedDays], [[], []]);
  });
});

describe('readiness for On: exactly three clean Shadow days', () => {
  const days = (n) => Array.from({ length: n }, (_, i) => `2026-11-0${i + 1}`).flatMap((d) => [job(d, 1), job(d, 2)]);
  test('two days is not enough, three is', async () => {
    const two = await loadReadiness({ query: fake({ jobs: days(2), sites: [site(1), site(2)] }).query, now: NOW });
    assert.equal(two.shadowDays, 2); assert.equal(two.ready, false);
    assert.equal(two.checks.find((c) => c.key === 'shadow-days').ok, false);
    assert.match(two.checks.find((c) => c.key === 'shadow-days').detail, /1 more/);
    const three = await loadReadiness({ query: fake({ jobs: days(3), sites: [site(1), site(2)] }).query, now: NOW });
    assert.equal(three.shadowDays, REQUIRED_SHADOW_DAYS); assert.equal(three.ready, true);
  });
  test('three days with one failed plan is not ready, and says which day', async () => {
    const r = await loadReadiness({ query: fake({ jobs: days(3), sites: [site(1), site(2)], planErrors: { '2026-11-02': 'timeout' } }).query, now: NOW });
    assert.equal(r.ready, false); assert.equal(r.failedPlans, 1);
    assert.match(r.checks.find((c) => c.key === 'no-failed-plans').detail, /2026-11-02/);
  });
  test('a missing table is not ready', async () => {
    const r = await loadReadiness({ query: fake({ jobs: days(3), sites: [site(1), site(2)], tables: { jobs: true, settings: false } }).query, now: NOW });
    assert.equal(r.migrationOk, false); assert.equal(r.ready, false);
  });
  test('the production-proof line is informational (ok: null) and never blocks', async () => {
    const r = await loadReadiness({ query: fake({ jobs: days(3), sites: [site(1), site(2)] }).query, now: NOW });
    assert.equal(r.checks.find((c) => c.key === 'production-proof').ok, null);
    assert.equal(r.ready, true);
  });
  test('the window starts when Shadow was last switched on, so an earlier bad day does not linger', async () => {
    const changes = [{ from_value: 'off', to_value: 'shadow', changed_by_email: 'a@b.test', changed_at: new Date('2026-11-04T09:00:00Z') }];
    const jobs = [job('2026-11-01', 1, true), job('2026-11-04', 1), job('2026-11-05', 1), job('2026-11-06', 1)];
    const r = await loadReadiness({ query: fake({ jobs, sites: [site(1)], changes }).query, now: NOW });
    assert.equal(r.failedPlans, 0); assert.equal(r.shadowDays, 3); assert.equal(r.ready, true);
  });
});

describe('setMasterMode', () => {
  const ready = () => fake({ jobs: ['2026-11-01', '2026-11-02', '2026-11-03'].flatMap((d) => [job(d, 1)]), sites: [site(1)], stored: 'shadow' });
  test('a bad mode is 400 BAD_MODE and writes nothing', async () => {
    const f = fake({});
    await assert.rejects(setMasterMode('turbo', { query: f.query, env: {}, now: NOW }), (e) => e instanceof MasterControlError && e.status === 400 && e.code === 'BAD_MODE');
    assert.equal(f.writes.length, 0);
  });
  test('the env ceiling refuses what it does not allow with 409 CEILING, but never refuses off', async () => {
    const f = ready();
    await assert.rejects(setMasterMode('on', { query: f.query, env: { MASTER_AGENT_MODE: 'shadow' }, now: NOW }), (e) => e.status === 409 && e.code === 'CEILING');
    await assert.rejects(setMasterMode('shadow', { query: f.query, env: { MASTER_AGENT_MODE: 'off' }, now: NOW }), (e) => e.code === 'CEILING');
    assert.equal(f.writes.length, 0);
    const out = await setMasterMode('off', { query: f.query, env: { MASTER_AGENT_MODE: 'off' }, now: NOW, by: 7, email: 'a@b.test' });
    assert.equal(out.changed, true);
  });
  test('On is refused until the Shadow bar is met (409 NOT_READY, with the reason), and allowed once it is', async () => {
    const early = fake({ jobs: [job('2026-11-05', 1)], sites: [site(1)], stored: 'shadow' });
    await assert.rejects(setMasterMode('on', { query: early.query, env: {}, now: NOW }), (e) => e.status === 409 && e.code === 'NOT_READY' && /at least 3 days/.test(e.message));
    assert.equal(early.writes.length, 0);
    const f = ready();
    const out = await setMasterMode('on', { query: f.query, env: {}, now: NOW, by: 7, email: 'a@b.test' });
    assert.deepEqual([out.changed, out.from, out.to], [true, 'shadow', 'on']);
    assert.deepEqual(f.writes[0], { key: MODE_KEY, value: 'on', by: 7, email: 'a@b.test' });
  });
  test('setting the mode it already has writes nothing, so history has no duplicate rows', async () => {
    const f = fake({ stored: 'shadow' });
    const out = await setMasterMode('shadow', { query: f.query, env: {}, now: NOW });
    assert.equal(out.changed, false);
    assert.equal(f.writes.length, 0);
  });
  test('switching clears the cache, so the new mode is read straight away', async () => {
    const f = fake({ stored: 'off' });
    assert.equal(await getMasterMode({ env: {}, query: f.query }), 'off'); // custom query: not cached, still fine
    await setMasterMode('shadow', { query: f.query, env: {}, now: NOW });
    assert.equal(await getMasterMode({ env: {}, query: f.query }), 'shadow');
  });
});

describe('the control half of the page payload', () => {
  test('shape: mode, ceiling, locked, canSwitch, readiness (without the internal flag), history newest first', async () => {
    const changes = [
      { from_value: 'off', to_value: 'shadow', changed_by_email: 'a@b.test', changed_at: new Date('2026-11-05T09:00:00Z') },
    ];
    const f = fake({ stored: 'shadow', jobs: [job('2026-11-05', 1)], sites: [site(1)], changes });
    const c = await loadMasterControl({ query: f.query, env: {}, now: NOW });
    assert.equal(c.mode, 'shadow'); assert.equal(c.ceiling, null); assert.equal(c.locked, false);
    assert.deepEqual(c.canSwitch.off, { ok: true });
    assert.deepEqual(c.canSwitch.shadow, { ok: true });
    assert.equal(c.canSwitch.on.ok, false); assert.match(c.canSwitch.on.reason, /3 days/);
    assert.equal(c.readiness.requiredShadowDays, 3); assert.equal(c.readiness.ready, undefined);
    assert.deepEqual(c.history, [{ at: changes[0].changed_at, by: 'a@b.test', from: 'off', to: 'shadow' }]);
  });
  test('a ceiling of off locks the page: only off is possible', async () => {
    const c = await loadMasterControl({ query: fake({ stored: 'on' }).query, env: { MASTER_AGENT_MODE: 'off' }, now: NOW });
    assert.equal(c.mode, 'off'); assert.equal(c.locked, true); assert.equal(c.ceiling, 'off');
    assert.equal(c.canSwitch.shadow.ok, false); assert.equal(c.canSwitch.on.ok, false); assert.equal(c.canSwitch.off.ok, true);
    assert.match(c.canSwitch.on.reason, /MASTER_AGENT_MODE=off/);
  });
  test('a first change shows "from off" even though the stored from-value was empty', async () => {
    const ch = [{ from_value: null, to_value: 'shadow', changed_by_email: 'a@b.test', changed_at: new Date() }];
    const c = await loadMasterControl({ query: fake({ stored: 'shadow', changes: ch }).query, env: {}, now: NOW });
    assert.equal(c.history[0].from, 'off');
  });
});

describe('recordPlanError', () => {
  test('keeps the last two weeks, writes quietly (no history row) and never throws', async () => {
    const old = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2026-10-${String(10 + i).padStart(2, '0')}`, 'x']));
    const f = fake({ planErrors: old });
    await recordPlanError({ day: '2026-11-06', message: 'boom', query: f.query });
    const w = f.writes.find((x) => x.quiet);
    assert.equal(Object.keys(w.value).length, 14);
    assert.equal(w.value['2026-11-06'], 'boom');
    await assert.doesNotReject(recordPlanError({ day: 'x', message: 'y', query: async () => { throw new Error('db down'); } }));
  });
});
