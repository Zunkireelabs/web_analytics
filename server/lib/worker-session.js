// THE WORKER'S DAY. Fixes are written by Claude Code on a laptop (claude-worker-provider.js), so they can only be written while that laptop is open.
// This decides WHEN the day's generation pass runs:

//   - not before 10:30 (site time), and never after 16:00: the day's PR must be ready by then, and an approval after the cut-off waits for tomorrow's PR

//   - only while a worker is connected: the pass starts when the laptop's worker reports in, and stops at the cut-off or when the worker goes away
//   - what is left over is not "failed": the next tick, or tomorrow, picks it up, because the pass reads the same open list each time
// With the worker off (LLM_WORKER_MODE not "on") none of this applies and the cron runs behave as before.
import { workerMode, workerFallback } from './claude-worker-provider.js';
import { hourInTimezone } from './ship-window.js';

// The window is counted in the laptop's own time zone (Nepal), NOT the server's: the server runs on India time (+05:30, TZ=Asia/Kolkata), which would make

// "17:00" 5:15 PM in Nepal. Override with WORKER_SESSION_TZ.

export const workerSessionTimezone = (env = process.env) => env.WORKER_SESSION_TZ || 'Asia/Kathmandu';

export const SESSION_START_MINUTE = 10 * 60 + 30; // 10:30
export const SESSION_CUTOFF_MINUTE = 17 * 60;     // 17:00 (was 14:00 until 2026-11-25, then 16:00; the whole day's work, finding, fixing and PRs, runs inside this window and every PR is open by 5 PM)
/**
 * The cron expression that ticks the session, DERIVED from the window so the two can never disagree. They were two hand-edited numbers:
 * on 2026-11-25 the cut-off in code said 16:00 while the deployed cron line still stopped at 13:55, so no pass could start after 14:00.
 * Fires every five minutes from the hour the window opens to the last hour before it closes.
 */
export const workerSessionCron = () => `*/5 ${Math.floor(SESSION_START_MINUTE / 60)}-${Math.ceil(SESSION_CUTOFF_MINUTE / 60) - 1} * * *`;
/**
 * The deadline steps, derived from the window like the session cron so they can never drift from it:
 *   consolidation  30 minutes before the cut-off: every project's validated work is brought to one pull request, or preserved with the exact reason
 *   close          at the cut-off and again 10 and 20 minutes later: every project's day record is closed. A project whose pass is still running is deferred to the
 *                  next run; the last run (CLOSE_FORCE_AFTER_MIN) closes whatever is left.
 */
export const CONSOLIDATION_LEAD_MIN = 30;
export const CLOSE_RETRY_MIN = [0, 10, 20];
export const CLOSE_FORCE_AFTER_MIN = 20;
export const deliveryConsolidationCron = () => { const m = SESSION_CUTOFF_MINUTE - CONSOLIDATION_LEAD_MIN; return `${m % 60} ${Math.floor(m / 60)} * * *`; };
export const deliveryCloseCron = () => `${CLOSE_RETRY_MIN.map((x) => (SESSION_CUTOFF_MINUTE % 60) + x).join(',')} ${Math.floor(SESSION_CUTOFF_MINUTE / 60)} * * *`;
/** True on the close run that must close everything left (the last of the retries). */
export const closeIsForced = (timezone, now = new Date()) => minuteOfDay(timezone, now) >= SESSION_CUTOFF_MINUTE + CLOSE_FORCE_AFTER_MIN;

export const workerSessionTimezone = (env = process.env) => env.WORKER_SESSION_TZ || 'Asia/Kathmandu';

export const SESSION_START_MINUTE = 10 * 60 + 30; // 10:30
export const SESSION_CUTOFF_MINUTE = 17 * 60;     // 17:00 (was 14:00 until 2026-11-25, then 16:00; the whole day's work, finding, fixing and PRs, runs inside this window and every PR is open by 5 PM)
/**
 * The cron expression that ticks the session, DERIVED from the window so the two can never disagree. They were two hand-edited numbers:
 * on 2026-11-25 the cut-off in code said 16:00 while the deployed cron line still stopped at 13:55, so no pass could start after 14:00.
 * Fires every five minutes from the hour the window opens to the last hour before it closes.
 */
export const workerSessionCron = () => `*/5 ${Math.floor(SESSION_START_MINUTE / 60)}-${Math.ceil(SESSION_CUTOFF_MINUTE / 60) - 1} * * *`;
/**
 * The deadline steps, derived from the window like the session cron so they can never drift from it:
 *   consolidation  30 minutes before the cut-off: every project's validated work is brought to one pull request, or preserved with the exact reason
 *   close          at the cut-off and again 10 and 20 minutes later: every project's day record is closed. A project whose pass is still running is deferred to the
 *                  next run; the last run (CLOSE_FORCE_AFTER_MIN) closes whatever is left.
 */
export const CONSOLIDATION_LEAD_MIN = 30;
export const CLOSE_RETRY_MIN = [0, 10, 20];
export const CLOSE_FORCE_AFTER_MIN = 20;
export const deliveryConsolidationCron = () => { const m = SESSION_CUTOFF_MINUTE - CONSOLIDATION_LEAD_MIN; return `${m % 60} ${Math.floor(m / 60)} * * *`; };
export const deliveryCloseCron = () => `${CLOSE_RETRY_MIN.map((x) => (SESSION_CUTOFF_MINUTE % 60) + x).join(',')} ${Math.floor(SESSION_CUTOFF_MINUTE / 60)} * * *`;
/** True on the close run that must close everything left (the last of the retries). */
export const closeIsForced = (timezone, now = new Date()) => minuteOfDay(timezone, now) >= SESSION_CUTOFF_MINUTE + CLOSE_FORCE_AFTER_MIN;

// "16:00" 4:15 PM in Nepal. Override with WORKER_SESSION_TZ.
export const workerSessionTimezone = (env = process.env) => env.WORKER_SESSION_TZ || 'Asia/Kathmandu';

export const SESSION_START_MINUTE = 10 * 60 + 30; // 10:30
export const SESSION_CUTOFF_MINUTE = 16 * 60;     // 16:00 (was 14:00 until 2026-11-25; the worker has more to write than fits before 2 PM)


export const MIN_GAP_MS = 20 * 60_000;            // a pass that found nothing to do is not repeated for this long

export function minuteOfDay(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}

/** @returns {{open:boolean, endsAt:number|null, minutesLeft:number}} Is the generation window open right now, and when does it close. */
export function sessionWindow(timezone, now = new Date()) {
  const m = minuteOfDay(timezone, now);
  const open = m >= SESSION_START_MINUTE && m < SESSION_CUTOFF_MINUTE;
  const minutesLeft = open ? SESSION_CUTOFF_MINUTE - m : 0;
  return { open, endsAt: open ? now.getTime() + minutesLeft * 60_000 : null, minutesLeft };
}

/**
 * Milliseconds from `now` until the worker window should be CLEAR of other heavy jobs (5 minutes before it opens), or null when it is
 * already open / past the cut-off today. Used to give the nightly re-check a deadline: on 2026-11-25 it started at 09:30 and ran for
 * more than five hours, straight through the 10:30-17:00 window the day's PRs depend on.
 */
export function msUntilWindowOpens(timezone, now = new Date(), leadMinutes = 5) {
  const m = minuteOfDay(timezone, now);
  const target = SESSION_START_MINUTE - leadMinutes;
  if (m >= target) return null;
  return (target - m) * 60_000;
}

/** True when generation is the worker's job, so the plain cron runs must not start it (they would only fail while the laptop is closed). */
export function deferToWorker(env = process.env) {
  return workerMode(env) && workerFallback(env) !== 'api';
}

/** For the dashboard: where the day's pass stands. Pure. */
export function describeSession({ timezone, now = new Date(), workerOnline, last, env = process.env }) {
  if (!workerMode(env)) return { mode: 'api', message: 'Fixes are written by the AI provider API.' };
  const w = sessionWindow(timezone, now);

  if (workerOnline && w.open) return { mode: 'worker', state: last?.running ? 'writing' : 'connected', message: last?.running ? 'The laptop worker is writing today\'s fixes.' : `The laptop worker is connected. Today\'s fixes are written until 17:00 (${w.minutesLeft} min left).` };
  if (workerOnline) return { mode: 'worker', state: 'connected-outside-window', message: 'The laptop worker is connected. Fixes are written between 10:30 and 17:00; anything left is picked up then.' };
  if (w.open) return { mode: 'worker', state: 'waiting', message: `Waiting for the laptop worker. Open the laptop and start it: the day's fixes are written until 17:00 (${w.minutesLeft} min left).` };



  if (workerOnline && w.open) return { mode: 'worker', state: last?.running ? 'writing' : 'connected', message: last?.running ? 'The laptop worker is writing today\'s fixes.' : `The laptop worker is connected. Today\'s fixes are written until 16:00 (${w.minutesLeft} min left).` };
  if (workerOnline) return { mode: 'worker', state: 'connected-outside-window', message: 'The laptop worker is connected. Fixes are written between 10:30 and 16:00; anything left is picked up then.' };
  if (w.open) return { mode: 'worker', state: 'waiting', message: `Waiting for the laptop worker. Open the laptop and start it: the day's fixes are written until 16:00 (${w.minutesLeft} min left).` };


  return { mode: 'worker', state: 'idle', message: 'The laptop worker is not connected. It is next needed from 10:30.' };
}

const state = { running: false, lastFinishedAt: 0, lastShipped: 0, lastAttempted: 0, lastStartedAt: 0, lastTick: null, skippedTicks: [] };
export const sessionState = () => ({ ...state, skippedTicks: [...state.skippedTicks] });
export function resetSessionStateForTests() { Object.assign(state, { running: false, lastFinishedAt: 0, lastShipped: 0, lastAttempted: 0, lastStartedAt: 0, lastTick: null, skippedTicks: [] }); }

// Every tick that did NOT start a pass is recorded with its reason. Before this a skipped tick left no trace at all, so "the worker did
// nothing today" and "the worker was never asked" looked the same. The log line is written when the REASON CHANGES (a tick every five
// minutes for seven hours would bury it); the in-memory list keeps the run of identical reasons as one entry with a count.
// 'outside-window' is not logged: it is the normal state for 17 hours a day. Database persistence of this list arrives with Phase 1.
const SKIP_LOG_MAX = 50;
export const QUIET_SKIPS = new Set(['outside-window']);
function recordTick(result, now, log) {
  const at = now.getTime();
  const prev = state.lastTick;
  state.lastTick = { at, ran: !!result.ran, why: result.why || (result.ran ? 'ran' : 'unknown'), error: result.error || null };
  if (result.ran) return result;
  const why = state.lastTick.why;
  const last = state.skippedTicks[state.skippedTicks.length - 1];
  if (last && last.why === why) { last.count += 1; last.lastAt = at; }
  else {
    state.skippedTicks.push({ why, error: result.error || null, firstAt: at, lastAt: at, count: 1 });
    if (state.skippedTicks.length > SKIP_LOG_MAX) state.skippedTicks.shift();
    if (!QUIET_SKIPS.has(why) && !(prev && !prev.ran && prev.why === why)) {
      log(`[worker-session] tick skipped: ${why}${result.error ? ` (${result.error})` : ''}`);
    }
  }
  return result;
}

/**
 * One tick (run every few minutes by cron, and when a worker reports in). Starts a pass when everything lines up; otherwise says why not.
 * @param {object} d  injected: timezone, now, isOnline(), runPass({windowEndsAt}) -> results[]
 */
export async function workerSessionTick(opts = {}) {
  const { now = new Date(), log = console.log } = opts;
  return recordTick(await runTick(opts), now, log);
}

async function runTick({ timezone, now = new Date(), env = process.env, isOnline, runPass, log = console.log } = {}) {
  if (!deferToWorker(env)) return { ran: false, why: 'worker-off' };
  if (state.running) return { ran: false, why: 'already-running' };
  const w = sessionWindow(timezone, now);
  if (!w.open) return { ran: false, why: 'outside-window' };
  // Claimed BEFORE the first await: two ticks arriving together must not both pass the check above.
  state.running = true;
  try {
    if (!(await isOnline())) { state.running = false; return { ran: false, why: 'worker-offline' }; }
    if (state.lastFinishedAt && state.lastAttempted === 0 && now.getTime() - state.lastFinishedAt < MIN_GAP_MS) { state.running = false; return { ran: false, why: 'nothing-left-recently' }; }
  } catch (err) {
    state.running = false;
    return { ran: false, why: 'check-failed', error: err.message };
  }
  state.lastStartedAt = now.getTime();
  log(`[worker-session] pass started, closes in ${w.minutesLeft} min`);
  try {
    const results = await runPass({ windowEndsAt: w.endsAt });
    const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
    state.lastShipped = sum('shipped'); state.lastAttempted = sum('attempted');
    log(`[worker-session] pass finished: ${state.lastAttempted} attempted, ${state.lastShipped} shipped across ${results.length} site(s)`);
    return { ran: true, shipped: state.lastShipped, attempted: state.lastAttempted };
  } catch (err) {
    log('[worker-session] pass error:', err.message);
    return { ran: true, error: err.message };
  } finally {
    state.running = false; state.lastFinishedAt = now.getTime();
  }
}
