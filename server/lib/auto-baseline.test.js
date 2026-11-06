import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, dailyCap, makeAutoBaselinePolicy, DEFAULT_DAILY_CAP, LIVE_SINCE_KEY, STATE_KEY } from './auto-baseline.js';

const NOW = new Date('2026-11-10T10:00:00Z');
const LIVE = '2026-11-09T08:00:00Z';
const site = (o = {}) => ({ id: 7, created_at: '2026-11-09T12:00:00Z', onboarded_at: null, ...o });

describe('who gets an automatic baseline', () => {
  test('a project created after the Master Agent went live does', () => {
    assert.deepEqual(decide({ site: site(), liveSince: LIVE, state: null, now: NOW }), { ok: true, reason: null });
  });
  test('a project that existed before it went live never does: it stays manual', () => {
    assert.equal(decide({ site: site({ created_at: '2026-11-01T00:00:00Z' }), liveSince: LIVE, state: null, now: NOW }).reason, 'existing-project');
    assert.equal(decide({ site: site({ created_at: null }), liveSince: LIVE, state: null, now: NOW }).reason, 'existing-project', 'no creation time: stay manual, never guess');
  });
  test('nothing starts while the Master Agent has never gone live', () => {
    assert.equal(decide({ site: site(), liveSince: null, state: null, now: NOW }).reason, 'master-agent-not-live');
  });
  test('a project that already has its baseline is left alone', () => {
    assert.equal(decide({ site: site({ onboarded_at: '2026-11-09T13:00:00Z' }), liveSince: LIVE, state: null, now: NOW }).reason, 'already-baselined');
  });
  test('the daily limit stops the spend, and a new day starts fresh', () => {
    const today = { day: '2026-11-10', started: { 1: '2026-11-10T03:00:00Z', 2: '2026-11-10T04:00:00Z', 3: '2026-11-10T05:00:00Z' } };
    assert.equal(decide({ site: site(), liveSince: LIVE, state: today, now: NOW, cap: 3 }).reason, 'daily-limit-reached');
    assert.equal(decide({ site: site(), liveSince: LIVE, state: { ...today, day: '2026-11-09' }, now: NOW, cap: 3 }).ok, true, 'yesterday\'s count does not carry over');
  });
  test('a project whose baseline is still running is not started a second time', () => {
    const state = { day: '2026-11-10', started: { 7: '2026-11-10T08:00:00Z' } };
    assert.equal(decide({ site: site(), liveSince: LIVE, state, now: NOW, cap: 3 }).reason, 'already-started');
  });
  test('a limit of 0 switches automatic baselines off', () => {
    assert.equal(decide({ site: site(), liveSince: LIVE, state: null, now: NOW, cap: 0 }).reason, 'automatic-baselines-off');
  });
  test('the limit defaults to 3 and can be set from the server', () => {
    assert.equal(DEFAULT_DAILY_CAP, 3);
    assert.equal(dailyCap({}), 3); assert.equal(dailyCap({ MASTER_AUTO_BASELINES_PER_DAY: '5' }), 5);
    assert.equal(dailyCap({ MASTER_AUTO_BASELINES_PER_DAY: '0' }), 0); assert.equal(dailyCap({ MASTER_AUTO_BASELINES_PER_DAY: 'x' }), 3);
  });
});

describe('the policy the Master Agent hands to the factory', () => {
  // A tiny in-memory stand-in for platform_settings, answering exactly the two SQL statements the policy uses.
  const memory = (initial = {}) => {
    const kv = { ...initial }; const writes = [];
    const query = async (sql, params) => {
      if (/SELECT value, updated_by/.test(sql)) return { rows: kv[params[0]] === undefined ? [] : [{ value: kv[params[0]], updated_by: null, updated_at: NOW }] };
      if (/INSERT INTO platform_settings/.test(sql)) { kv[params[0]] = JSON.parse(params[1]); writes.push(params[0]); return { rows: [] }; }
      throw new Error(`unexpected sql ${sql}`);
    };
    return { query, kv, writes };
  };
  test('records the start BEFORE launching it, and counts it against the day', async () => {
    const m = memory({ [LIVE_SINCE_KEY]: LIVE }); const order = [];
    const p = await makeAutoBaselinePolicy({ query: m.query, now: NOW, env: {}, start: (s) => order.push(`start:${s.id}:${m.kv[STATE_KEY]?.started?.[s.id] ? 'recorded' : 'NOT-recorded'}`) });
    assert.equal((await p.allow(site())).ok, true);
    await p.run(site());
    assert.deepEqual(order, ['start:7:recorded'], 'a crash after the write can never start the same project twice');
    assert.equal(p.startedToday(), 1);
    assert.equal((await p.allow(site())).reason, 'already-started');
  });
  test('stops at the daily limit across several projects', async () => {
    const m = memory({ [LIVE_SINCE_KEY]: LIVE }); let launched = 0;
    const p = await makeAutoBaselinePolicy({ query: m.query, now: NOW, env: { MASTER_AUTO_BASELINES_PER_DAY: '2' }, start: () => { launched++; } });
    for (const id of [1, 2, 3, 4]) { if ((await p.allow(site({ id }))).ok) await p.run(site({ id })); }
    assert.equal(launched, 2);
    assert.equal((await p.allow(site({ id: 5 }))).reason, 'daily-limit-reached');
  });
  test('with no live time recorded nothing is ever allowed', async () => {
    const m = memory(); const p = await makeAutoBaselinePolicy({ query: m.query, now: NOW, env: {}, start: () => assert.fail('must not start') });
    assert.equal((await p.allow(site())).reason, 'master-agent-not-live');
  });
  test('a settings table that cannot be read means nothing starts, never a crash', async () => {
    const p = await makeAutoBaselinePolicy({ query: async () => { throw new Error('db down'); }, now: NOW, env: {}, start: () => assert.fail('must not start') });
    assert.equal((await p.allow(site())).ok, false);
  });
});
