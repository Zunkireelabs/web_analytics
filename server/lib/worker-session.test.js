import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { workerSessionTimezone, sessionWindow, deferToWorker, describeSession, workerSessionTick, resetSessionStateForTests, minuteOfDay, msUntilWindowOpens, sessionState, workerSessionCron, SESSION_START_MINUTE, SESSION_CUTOFF_MINUTE } = await import('./worker-session.js');

const ON = { LLM_WORKER_MODE: 'on' };
const at = (hhmm) => new Date(`2026-11-24T${hhmm}:00Z`); // timezone UTC in these tests
beforeEach(() => resetSessionStateForTests());

describe('the window', () => {

  test('closed before 10:30, open from 10:30 until 17:00, closed from 17:00', () => {


  test('closed before 10:30, open from 10:30 until 17:00, closed from 17:00', () => {
    assert.equal(sessionWindow('UTC', at('10:29')).open, false);
    assert.equal(sessionWindow('UTC', at('10:30')).open, true);
    assert.equal(sessionWindow('UTC', at('16:59')).open, true);
    assert.equal(sessionWindow('UTC', at('17:00')).open, false);
  });
  test('it ends at 17:00 sharp and counts minutes left', () => {
    const now = at('14:30'); const w = sessionWindow('UTC', now);
    assert.equal(w.minutesLeft, 150);
    assert.equal(w.endsAt, now.getTime() + 150 * 60_000);

  test('closed before 10:30, open from 10:30 until 16:00, closed from 16:00', () => {

    assert.equal(sessionWindow('UTC', at('10:29')).open, false);
    assert.equal(sessionWindow('UTC', at('10:30')).open, true);
    assert.equal(sessionWindow('UTC', at('16:59')).open, true);
    assert.equal(sessionWindow('UTC', at('17:00')).open, false);
  });
  test('it ends at 17:00 sharp and counts minutes left', () => {
    const now = at('14:30'); const w = sessionWindow('UTC', now);

    assert.equal(w.minutesLeft, 150);
    assert.equal(w.endsAt, now.getTime() + 150 * 60_000);

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

  test('runs a pass when the worker is online inside the window, with the 17:00 end', async () => {


  test('runs a pass when the worker is online inside the window, with the 17:00 end', async () => {
    const { args, calls } = mk(); const r = await workerSessionTick(args);
    assert.deepEqual(r, { ran: true, shipped: 2, attempted: 3 });
    assert.equal(calls[0].windowEndsAt, at('17:00').getTime());
  });
  test('does nothing with the worker off, outside the window, or with no worker connected', async () => {
    assert.equal((await workerSessionTick(mk({ env: {} }).args)).why, 'worker-off');
    assert.equal((await workerSessionTick(mk({ now: at('17:05') }).args)).why, 'outside-window');

  test('runs a pass when the worker is online inside the window, with the 16:00 end', async () => {

    const { args, calls } = mk(); const r = await workerSessionTick(args);
    assert.deepEqual(r, { ran: true, shipped: 2, attempted: 3 });
    assert.equal(calls[0].windowEndsAt, at('17:00').getTime());
  });
  test('does nothing with the worker off, outside the window, or with no worker connected', async () => {
    assert.equal((await workerSessionTick(mk({ env: {} }).args)).why, 'worker-off');

    assert.equal((await workerSessionTick(mk({ now: at('17:05') }).args)).why, 'outside-window');

    assert.equal((await workerSessionTick(mk({ now: at('16:05') }).args)).why, 'outside-window');


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
    assert.equal(d({ now: at('17:00'), workerOnline: false }).state, 'idle');
    assert.equal(d({ now: at('17:00'), workerOnline: true }).state, 'connected-outside-window');
  });
});


test('the window is counted in Nepal time by default, so it closes at 5 PM Nepal, not 5:15 PM', () => {
  assert.equal(workerSessionTimezone({}), 'Asia/Kathmandu');
  assert.equal(workerSessionTimezone({ WORKER_SESSION_TZ: 'Asia/Kolkata' }), 'Asia/Kolkata');
  // 16:55 Nepal = 11:10 UTC: still open with 5 minutes left; 17:00 Nepal = 11:15 UTC: closed. In India time that second moment would still read 16:45 (open).
  assert.deepEqual([sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:10:00Z')).open, sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:10:00Z')).minutesLeft], [true, 5]);
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:15:00Z')).open, false);


test('the window is counted in Nepal time by default, so it closes at 5 PM Nepal, not 5:15 PM', () => {
  assert.equal(workerSessionTimezone({}), 'Asia/Kathmandu');
  assert.equal(workerSessionTimezone({ WORKER_SESSION_TZ: 'Asia/Kolkata' }), 'Asia/Kolkata');
  // 16:55 Nepal = 11:10 UTC: still open with 5 minutes left; 17:00 Nepal = 11:15 UTC: closed. In India time that second moment would still read 16:45 (open).
  assert.deepEqual([sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:10:00Z')).open, sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:10:00Z')).minutesLeft], [true, 5]);
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T11:15:00Z')).open, false);

test('the window is counted in Nepal time by default, so it closes at 4 PM Nepal, not 4:15 PM', () => {
  assert.equal(workerSessionTimezone({}), 'Asia/Kathmandu');
  assert.equal(workerSessionTimezone({ WORKER_SESSION_TZ: 'Asia/Kolkata' }), 'Asia/Kolkata');
  // 15:55 Nepal = 10:10 UTC: still open with 5 minutes left; 16:00 Nepal = 10:15 UTC: closed. In India time that second moment would still read 15:45 (open).
  assert.deepEqual([sessionWindow('Asia/Kathmandu', new Date('2026-11-24T10:10:00Z')).open, sessionWindow('Asia/Kathmandu', new Date('2026-11-24T10:10:00Z')).minutesLeft], [true, 5]);
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T10:15:00Z')).open, false);


  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T05:00:00Z')).open, true);  // 10:45 Nepal, open (opens 10:30)
  assert.equal(sessionWindow('Asia/Kathmandu', new Date('2026-11-24T04:40:00Z')).open, false); // 10:25 Nepal, not yet
});

describe('msUntilWindowOpens (the re-check\'s deadline)', () => {
  test('counts down to five minutes before 10:30, and is null once that moment has passed', () => {
    assert.equal(msUntilWindowOpens('UTC', at('09:30')), 55 * 60_000);
    assert.equal(msUntilWindowOpens('UTC', at('10:24')), 1 * 60_000);
    assert.equal(msUntilWindowOpens('UTC', at('10:25')), null);
    assert.equal(msUntilWindowOpens('UTC', at('14:00')), null);
  });
  test('uses the Nepal clock, not the server\'s', () => {
    assert.equal(msUntilWindowOpens('Asia/Kathmandu', new Date('2026-11-25T04:00:00Z')), 40 * 60_000); // 09:45 Nepal
  });
});

describe('skipped ticks are recorded, not silent', () => {
  const mk = (over = {}) => ({ timezone: 'UTC', now: at('11:00'), env: ON, isOnline: async () => true, runPass: async () => [{ shipped: 1, attempted: 1 }], log: () => {}, ...over });
  test('a worker that is offline all morning is one logged line and one counted entry, not 80 lines', async () => {
    const lines = []; let t = at('10:30').getTime();
    for (let i = 0; i < 20; i++) { await workerSessionTick(mk({ now: new Date(t), isOnline: async () => false, log: (m) => lines.push(m) })); t += 5 * 60_000; }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /tick skipped: worker-offline/);
    const s = sessionState().skippedTicks;
    assert.equal(s.length, 1); assert.equal(s[0].count, 20); assert.equal(s[0].why, 'worker-offline');
  });
  test('a change of reason is logged again, outside-window is never logged, a pass is not a skip', async () => {
    const lines = []; const log = (m) => lines.push(m);
    await workerSessionTick(mk({ now: at('09:00'), log }));
    await workerSessionTick(mk({ isOnline: async () => false, log }));
    await workerSessionTick(mk({ isOnline: async () => { throw new Error('db down'); }, now: at('11:05'), log }));
    await workerSessionTick(mk({ now: at('11:10'), log }));
    assert.equal(lines.filter((l) => /tick skipped/.test(l)).length, 2);
    assert.ok(lines.some((l) => /check-failed \(db down\)/.test(l)));
    assert.deepEqual(sessionState().skippedTicks.map((x) => x.why), ['outside-window', 'worker-offline', 'check-failed']);
    assert.equal(sessionState().lastTick.ran, true);
  });
  test('the list is capped', async () => {
    for (let i = 0; i < 80; i++) await workerSessionTick(mk({ now: at('11:00'), env: i % 2 ? {} : ON, isOnline: async () => false }));
    assert.ok(sessionState().skippedTicks.length <= 50);
  });
});

describe('the cron line follows the window', () => {
  test('ticks every five minutes from 10:00 to 16:55, so the 10:30-17:00 window is fully covered', () => {
    assert.equal(workerSessionCron(), '*/5 10-16 * * *');
  });
  test('every minute the window is open falls inside the cron hours (no gap like the 13:55 stop of 2026-11-25)', () => {
    const [, hours] = workerSessionCron().split(' ');
    const [from, to] = hours.split('-').map(Number);
    for (let m = SESSION_START_MINUTE; m < SESSION_CUTOFF_MINUTE; m += 5) { const h = Math.floor(m / 60); assert.ok(h >= from && h <= to, `minute ${m} (hour ${h}) is outside ${hours}`); }
  });
});
