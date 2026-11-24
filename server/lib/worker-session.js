// THE WORKER'S DAY. Fixes are written by Claude Code on a laptop (claude-worker-provider.js), so they can only be written while that laptop is open.
// This decides WHEN the day's generation pass runs:
//   - not before 10:30 (site time), and never after 14:00: the day's PR must be ready by then, and an approval after the cut-off waits for tomorrow's PR
//   - only while a worker is connected: the pass starts when the laptop's worker reports in, and stops at the cut-off or when the worker goes away
//   - what is left over is not "failed": the next tick, or tomorrow, picks it up, because the pass reads the same open list each time
// With the worker off (LLM_WORKER_MODE not "on") none of this applies and the cron runs behave as before.
import { workerMode, workerFallback } from './claude-worker-provider.js';
import { hourInTimezone } from './ship-window.js';

// The window is counted in the laptop's own time zone (Nepal), NOT the server's: the server runs on India time (+05:30, TZ=Asia/Kolkata), which would make
// "14:00" 2:15 PM in Nepal. Override with WORKER_SESSION_TZ.
export const workerSessionTimezone = (env = process.env) => env.WORKER_SESSION_TZ || 'Asia/Kathmandu';

export const SESSION_START_MINUTE = 10 * 60 + 30; // 10:30
export const SESSION_CUTOFF_MINUTE = 14 * 60;     // 14:00
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

/** True when generation is the worker's job, so the plain cron runs must not start it (they would only fail while the laptop is closed). */
export function deferToWorker(env = process.env) {
  return workerMode(env) && workerFallback(env) !== 'api';
}

/** For the dashboard: where the day's pass stands. Pure. */
export function describeSession({ timezone, now = new Date(), workerOnline, last, env = process.env }) {
  if (!workerMode(env)) return { mode: 'api', message: 'Fixes are written by the AI provider API.' };
  const w = sessionWindow(timezone, now);
  if (workerOnline && w.open) return { mode: 'worker', state: last?.running ? 'writing' : 'connected', message: last?.running ? 'The laptop worker is writing today\'s fixes.' : `The laptop worker is connected. Today\'s fixes are written until 14:00 (${w.minutesLeft} min left).` };
  if (workerOnline) return { mode: 'worker', state: 'connected-outside-window', message: 'The laptop worker is connected. Fixes are written between 10:30 and 14:00; anything left is picked up then.' };
  if (w.open) return { mode: 'worker', state: 'waiting', message: `Waiting for the laptop worker. Open the laptop and start it: the day's fixes are written until 14:00 (${w.minutesLeft} min left).` };
  return { mode: 'worker', state: 'idle', message: 'The laptop worker is not connected. It is next needed from 10:30.' };
}

const state = { running: false, lastFinishedAt: 0, lastShipped: 0, lastAttempted: 0, lastStartedAt: 0 };
export const sessionState = () => ({ ...state });
export function resetSessionStateForTests() { Object.assign(state, { running: false, lastFinishedAt: 0, lastShipped: 0, lastAttempted: 0, lastStartedAt: 0 }); }

/**
 * One tick (run every few minutes by cron, and when a worker reports in). Starts a pass when everything lines up; otherwise says why not.
 * @param {object} d  injected: timezone, now, isOnline(), runPass({windowEndsAt}) -> results[]
 */
export async function workerSessionTick({ timezone, now = new Date(), env = process.env, isOnline, runPass, log = console.log } = {}) {
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
