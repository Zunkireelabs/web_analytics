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
