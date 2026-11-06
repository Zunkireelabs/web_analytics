import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { masterMode, limits, backoffMs, orderForFairness, estimateMakespanMs, Resources, KINDS } from './master-agent.js';

describe('mode and limits', () => {
  test('the default is off, and junk is off', () => {
    assert.equal(masterMode({}), 'off');
    assert.equal(masterMode({ MASTER_AGENT_MODE: 'banana' }), 'off');
    assert.equal(masterMode({ MASTER_AGENT_MODE: 'SHADOW' }), 'shadow');
    assert.equal(masterMode({ MASTER_AGENT_MODE: 'on' }), 'on');
  });
  test('defaults reproduce today: one worker, one browser slot', () => {
    const l = limits({});
    assert.deepEqual([l.concurrency, l.browserSlots], [1, 1]);
  });
  test('bad numbers fall back to the safe default', () => {
    for (const bad of ['0', '-3', 'x', '']) assert.equal(limits({ MASTER_AGENT_CONCURRENCY: bad }).concurrency, 1);
    assert.equal(limits({ MASTER_AGENT_CONCURRENCY: '4' }).concurrency, 4);
  });
});

describe('backoff', () => {
  test('grows, then stays at the cap', () => {
    assert.deepEqual([1, 2, 3, 4, 9].map(backoffMs), [5, 15, 45, 45, 45].map((m) => m * 60000));
    assert.equal(backoffMs(0), 5 * 60000);
  });
});

describe('fairness', () => {
  const now = new Date('2026-12-10T05:00:00Z');
  const sites = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  test('never-run first, then the longest wait', () => {
    const last = new Map([[1, '2026-12-09T05:30:00Z'], [2, '2026-12-01T05:30:00Z'], [4, '2026-12-08T05:30:00Z']]);
    const ids = orderForFairness(sites, last, now).map((s) => s.id);
    assert.equal(ids[0], 3, 'never succeeded goes first');
    assert.deepEqual(ids.slice(1), [2, 4, 1]);
  });
  test('it does not mutate its input and is stable for equal waits', () => {
    const copy = [...sites];
    orderForFairness(sites, new Map(), now);
    assert.deepEqual(sites, copy);
    const a = orderForFairness(sites, new Map(), now).map((s) => s.id);
    const b = orderForFairness(sites, new Map(), now).map((s) => s.id);
    assert.deepEqual(a, b);
  });
  test('ties rotate from day to day so one project is not always last', () => {
    const d1 = orderForFairness(sites, new Map(), new Date('2026-12-10T05:00:00Z')).map((s) => s.id);
    const d2 = orderForFairness(sites, new Map(), new Date('2026-12-11T05:00:00Z')).map((s) => s.id);
    assert.notDeepEqual(d1, d2);
  });
});

describe('capacity arithmetic', () => {
  const twelveMin = 12 * 60000;
  test('100 projects at 12 minutes, one worker: 20 hours, which does not fit in a day window', () => {
    const ms = estimateMakespanMs(Array(100).fill(twelveMin), { concurrency: 1, browserSlots: 1 });
    assert.equal(ms / 3600000, 20);
  });
  test('more workers do not help while there is one browser slot', () => {
    const a = estimateMakespanMs(Array(100).fill(twelveMin), { concurrency: 8, browserSlots: 1 });
    assert.equal(a, estimateMakespanMs(Array(100).fill(twelveMin), { concurrency: 1, browserSlots: 1 }));
  });
  test('workers and browser slots together divide the time', () => {
    const ms = estimateMakespanMs(Array(100).fill(twelveMin), { concurrency: 4, browserSlots: 4 });
    assert.equal(ms / 3600000, 5);
  });
  test('never less than the longest single job, and zero for nothing', () => {
    assert.equal(estimateMakespanMs([60 * 60000, 1000], { concurrency: 8, browserSlots: 8 }), 60 * 60000);
    assert.equal(estimateMakespanMs([]), 0);
  });
  test('the daily kind holds the browser', () => assert.deepEqual(KINDS.daily.resources, ['browser']));
});

describe('resources', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  test('never more holders than the cap, and everyone gets a turn', async () => {
    const res = new Resources({ browser: 2 });
    let now = 0; let peak = 0; let done = 0;
    await Promise.all(Array.from({ length: 10 }, async () => {
      const release = await res.acquireAll(['browser']);
      now++; peak = Math.max(peak, now);
      await sleep(5);
      now--; release(); done++;
    }));
    assert.equal(peak, 2);
    assert.equal(done, 10);
  });
  test('release is idempotent and a key with no cap is unlimited', async () => {
    const res = new Resources({ browser: 1 });
    const r = await res.acquireAll(['browser']);
    r(); r();
    assert.equal(res.used.browser, 0);
    const a = await res.acquireAll(['other']); const b = await res.acquireAll(['other']);
    a(); b();
  });
  test('taking several resources in any order cannot deadlock', async () => {
    const res = new Resources({ a: 1, b: 1 });
    const run = async (keys) => { const r = await res.acquireAll(keys); await sleep(3); r(); };
    await Promise.race([Promise.all([run(['a', 'b']), run(['b', 'a']), run(['a', 'b']), run(['b', 'a'])]), sleep(2000).then(() => { throw new Error('deadlock'); })]);
  });
});
