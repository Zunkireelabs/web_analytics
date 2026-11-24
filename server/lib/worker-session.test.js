import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { workerSessionTimezone, sessionWindow, deferToWorker, describeSession, workerSessionTick, resetSessionStateForTests, minuteOfDay } = await import('./worker-session.js');

const ON = { LLM_WORKER_MODE: 'on' };
const at = (hhmm) => new Date(`2026-11-24T${hhmm}:00Z`); // timezone UTC in these tests
beforeEach(() => resetSessionStateForTests());

describe('the window', () => {
  test('closed before 10:30, open from 10:30 until 14:00, closed from 14:00', () => {
    assert.equal(sessionWindow('UTC', at('10:29')).open, false);
    assert.equal(sessionWindow('UTC', at('10:30')).open, true);
    assert.equal(sessionWindow('UTC', at('13:59')).open, true);
    assert.equal(sessionWindow('UTC', at('14:00')).open, false);
  });
  test('it ends at 14:00 sharp and counts minutes left', () => {
    const now = at('12:30'); const w = sessionWindow('UTC', now);
    assert.equal(w.minutesLeft, 90);
    assert.equal(w.endsAt, now.getTime() + 90 * 60_000);
  });
  test('uses the site\'s time zone', () => {
    assert.equal(minuteOfDay('Asia/Kathmandu', at('05:00')), 10 * 60 + 45); // UTC+5:45
    assert.equal(sessionWindow('Asia/Kathmandu', at('05:00')).open, true);
  });
});

describe('deferToWorker', () => {
  test('only in worker mode without the API fallback', () => {
    assert.equal(deferToWorker({}), false);
    assert.equal(deferToWorker(ON), true);
    assert.equal(deferToWorker({ ...ON, LLM_WORKER_FALLBACK: 'api' }), false);
  });
});

describe('workerSessionTick', () => {
  const mk = (over = {}) => { const calls = []; return { calls, args: { timezone: 'UTC', now: at('11:00'), env: ON, isOnline: async () => true, runPass: async (o) => { calls.push(o); return [{ shipped: 2, attempted: 3 }]; }, log: () => {}, ...over } }; };
  test('runs a pass when the worker is online inside the window, with the 14:00 end', async () => {
    const { args, calls } = mk(); const r = await workerSessionTick(args);
    assert.deepEqual(r, { ran: true, shipped: 2, attempted: 3 });
    assert.equal(calls[0].windowEndsAt, at('14:00').getTime());
  });
  test('does nothing with the worker off, outside the window, or with no worker connected', async () => {
    assert.equal((await workerSessionTick(mk({ env: {} }).args)).why, 'worker-off');
    assert.equal((await workerSessionTick(mk({ now: at('14:05') }).args)).why, 'outside-window');
    assert.equal((await workerSessionTick(mk({ now: at('09:00') }).args)).why, 'outside-window');
    const { args, calls } = mk({ isOnline: async () => false });
    assert.equal((await workerSessionTick(args)).why, 'worker-offline');
    assert.equal(calls.length, 0);
  });
  test('never two passes at once', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { args } = mk({ runPass: async () => { await gate; return []; } });
    const first = workerSessionTick(args);
    assert.equal((await workerSessionTick(args)).why, 'already-running');
    release(); await first;
  });
  test('a pass that found nothing is not repeated straight away, but one that did work is', async () => {
    const idle = mk({ runPass: async () => [{ shipped: 0, attempted: 0 }] });
    await workerSessionTick(idle.args);
    assert.equal((await workerSessionTick(idle.args)).why, 'nothing-left-recently');
    resetSessionStateForTests();
    const busy = mk(); await workerSessionTick(busy.args);
    assert.equal((await workerSessionTick(busy.args)).ran, true);
  });
  test('an error in the pass is reported and does not throw or leave the lock held', async () => {
    const { args } = mk({ runPass: async () => { throw new Error('boom'); } });
    assert.deepEqual(await workerSessionTick(args), { ran: true, error: 'boom' });
    assert.equal((await workerSessionTick(args)).why, 'nothing-left-recently', 'backs off after an error');
    assert.equal((await workerSessionTick(mk({ now: at('11:30') }).args)).ran, true, 'and the lock was released');
  });
});

describe('describeSession (what the dashboard says)', () => {
  const d = (o) => describeSession({ timezone: 'UTC', env: ON, ...o });
  test('api mode says so', () => assert.equal(describeSession({ timezone: 'UTC', env: {}, workerOnline: false }).mode, 'api'));
  test('waiting for the laptop inside the window', () => { const r = d({ now: at('11:00'), workerOnline: false }); assert.equal(r.state, 'waiting'); assert.match(r.message, /Open the laptop/); });
  test('connected and writing', () => { const r = d({ now: at('11:00'), workerOnline: true, last: { running: true } }); assert.equal(r.state, 'writing'); });
  test('outside the window it is idle or connected-outside-window', () => {
    assert.equal(d({ now: at('16:00'), workerOnline: false }).state, 'idle');
    assert.equal(d({ now: at('16:00'), workerOnline: true }).state, 'connected-outside-window');
  });
});

test('the window is counted in Nepal time by default, so it closes at 2 PM Nepal, not 2:15 PM', () => {
  assert.equal(workerSessionTimezone({}), 'Asia/Kathmandu');
  assert.equal(workerSessionTimezone({ WORKER_SESSION_TZ: 'Asia/Kolkata' }), 'Asia/Kolkata');
  // 13:55 Nepal = 08:10 UTC: still open with 5 minutes left; 14:00 Nepal = 08:15 UTC: closed. In India time that second moment would still read 13:45 (open).
  assert.deepEqual([sessionWindow('Asia/Kathmandu', new Date('2026-11-24T08:10:00Z')).open, sessionWindow('Asia/Kathmandu', new Date('2026-11-24T08:10:00Z')).minutesLeft], [true, 5]);
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T08:15:00Z')).open, false);
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T05:00:00Z')).open, true);  // 10:45 Nepal, open (opens 10:30)
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T04:40:00Z')).open, false); // 10:25 Nepal, not yet
});
