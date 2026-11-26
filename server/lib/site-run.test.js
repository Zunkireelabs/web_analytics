import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateForToday, runSiteWithDeadline, windowClosed, RUN_WINDOW_MS, SITE_RUN_TIMEOUT_MS } from './site-run.js';

const DAY = 86400000;
test('rotation starts somewhere else each day and keeps everyone', () => {
  const list = [1, 2, 3, 4];
  const first = (d) => rotateForToday(list, d * DAY)[0];
  assert.notEqual(first(1), first(2));
  assert.deepEqual([...rotateForToday(list, 5 * DAY)].sort(), list);
  assert.deepEqual(rotateForToday(list, 3 * DAY), rotateForToday(list, 3 * DAY + 1000), 'same day, same order');
  assert.deepEqual(rotateForToday([9], DAY), [9]);
  assert.deepEqual(rotateForToday([], DAY), []);
});

test('a site that finishes in time returns its value and is given a deadline', async () => {
  const r = await runSiteWithDeadline({ id: 1 }, async ({ deadlineAt }) => { assert.ok(deadlineAt > Date.now()); return 7; }, { timeoutMs: 1000, graceMs: 50 });
  assert.deepEqual(r, { ok: true, value: 7 });
});

test('a site that throws is reported, not thrown', async () => {
  const r = await runSiteWithDeadline({ id: 1 }, async () => { throw new Error('boom'); }, { timeoutMs: 1000, graceMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'boom');
});

test('a hung site is abandoned, recorded, and the pass moves on', async () => {
  const recorded = [];
  const never = new Promise(() => {});
  const r = await runSiteWithDeadline({ id: 2, name: 's' }, () => never, { timeoutMs: 10, graceMs: 10, onTimeout: async (s) => { recorded.push(s.id); } });
  assert.deepEqual(r, { ok: false, timedOut: true });
  assert.deepEqual(recorded, [2]);
});

test('an abandoned run that rejects later is not an unhandled rejection', async () => {
  let rejectLater;
  const late = new Promise((_, rej) => { rejectLater = rej; });
  await runSiteWithDeadline({ id: 3 }, () => late, { timeoutMs: 5, graceMs: 5 });
  rejectLater(new Error('late'));
  await new Promise((r) => setTimeout(r, 20));
});

test('an abandoned run is told to stop, so it does not keep working in the background', async () => {
  let abortedSeen = null;
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = await runSiteWithDeadline({ id: 4 }, async ({ isAborted }) => { await gate; abortedSeen = isAborted(); }, { timeoutMs: 5, graceMs: 5 });
  assert.equal(r.timedOut, true);
  release();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(abortedSeen, true);
});

test('the morning window is four hours, and one client gets thirty minutes', () => {
  assert.equal(RUN_WINDOW_MS, 4 * 60 * 60 * 1000);
  assert.equal(SITE_RUN_TIMEOUT_MS, 30 * 60 * 1000);
});

test('the morning window is open until its end, closed from then on, and never closed when there is no window', () => {
  const end = 1_000_000;
  assert.equal(windowClosed(end, end - 1), false);
  assert.equal(windowClosed(end, end), true);
  assert.equal(windowClosed(end, end + 5), true);
  assert.equal(windowClosed(null, end + 5), false);
});

import { describe } from 'node:test';
import { orderByUrgency, orderByTurn } from './site-run.js';
describe('orderByUrgency', () => {
  const sites = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  test('the site with the most open high-priority work goes first', () => {
    assert.deepEqual(orderByUrgency(sites, new Map([[3, 9], [2, 4]])).map((s) => s.id), [3, 2, 1, 4]);
  });
  test('equal urgency keeps the incoming (rotated) order, so nobody is permanently last', () => {
    assert.deepEqual(orderByUrgency(sites, new Map([[1, 2], [2, 2], [3, 2], [4, 2]])).map((s) => s.id), [1, 2, 3, 4]);
    assert.deepEqual(orderByUrgency([sites[2], sites[3], sites[0], sites[1]], new Map()).map((s) => s.id), [3, 4, 1, 2]);
  });
  test('a site with only lower-priority work is still in the list, just later', () => {
    const out = orderByUrgency(sites, new Map([[4, 1]])).map((s) => s.id);
    assert.equal(out.length, 4);
    assert.equal(out[0], 4);
  });
  test('no data returns the list unchanged and never mutates it', () => {
    const copy = [...sites];
    assert.equal(orderByUrgency(sites, null), sites);
    orderByUrgency(sites, new Map([[4, 5]]));
    assert.deepEqual(sites, copy);
  });
});

describe('orderByTurn (whoever was served longest ago today goes first)', () => {
  const sites = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const ids = (l) => l.map((s) => s.id);
  test('on the day\'s first pass nobody has been served, so the urgency order stands unchanged', () => {
    assert.deepEqual(ids(orderByTurn(sites, new Map())), [1, 2, 3, 4]);
    assert.deepEqual(ids(orderByTurn(sites, undefined)), [1, 2, 3, 4]);
  });
  test('a project not yet reached today goes before every project that was, then oldest-served first', () => {
    const servedAt = new Map([[1, 5000], [3, 1000], [2, 9000]]); // 4 never served today
    assert.deepEqual(ids(orderByTurn(sites, servedAt)), [4, 3, 1, 2]);
  });
  test('ties keep the urgency order, so the busiest project is not pushed behind an equally recent one', () => {
    assert.deepEqual(ids(orderByTurn(sites, new Map([[1, 1000], [2, 1000], [3, 1000], [4, 1000]]))), [1, 2, 3, 4]);
  });
  test('the project that led the previous pass (and used its 30 minutes) goes last next time', () => {
    const servedAt = new Map([[1, 60_000 * 90], [2, 60_000 * 50], [3, 60_000 * 55], [4, 60_000 * 60]]);
    assert.equal(orderByTurn(sites, servedAt).at(-1).id, 1);
  });
  test('does not mutate its input and handles tiny lists', () => {
    const copy = [...sites]; orderByTurn(sites, new Map([[1, 5]]));
    assert.deepEqual(sites, copy);
    assert.deepEqual(orderByTurn([], new Map([[1, 5]])), []);
    assert.deepEqual(orderByTurn([{ id: 9 }], new Map([[9, 5]])), [{ id: 9 }]);
  });
});
