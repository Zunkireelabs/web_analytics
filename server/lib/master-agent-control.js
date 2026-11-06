import { query as dbQuery } from '../db.js';
import { isSchedulable } from './instance-lifecycle.js';
import { getSetting, setSetting, putSettingQuiet, listChanges } from './platform-settings.js';
import { LIVE_SINCE_KEY, autoBaselineStatus } from './auto-baseline.js';

// Everything the Platform page needs to SWITCH the Master Agent between off / shadow / on (migration 246), kept apart from
// lib/master-agent.js (the queue itself) so the queue has no dependency on how its mode is chosen.
//
// WHO DECIDES THE MODE
//   1. The platform_settings row 'master_agent_mode' ("off" | "shadow" | "on"), set from the Platform page. No row = 'off'.
//   2. The MASTER_AGENT_MODE environment variable is now a hard CEILING on that row, not a second way to set it:
//        unset  -> no ceiling (the page decides);   off -> locked off;   shadow -> at most shadow;   on -> anything;
//        any other non-empty value -> treated as 'off' (fail closed, never open).
//      A person with server access can therefore always force it down, whatever the page says.
//   Reading the mode never throws: if the database cannot be read the answer is 'off' (the safe one) and is not cached.

export const MODES = Object.freeze(['off', 'shadow', 'on']);
const RANK = Object.freeze({ off: 0, shadow: 1, on: 2 });
export const MODE_KEY = 'master_agent_mode';
export const PLAN_ERRORS_KEY = 'master_agent_plan_errors';
export const REQUIRED_SHADOW_DAYS = 3;
const WINDOW_DAYS = 14;        // how far back shadow days are looked at
const CACHE_MS = 30 * 1000;

export class MasterControlError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10); // the platform's day is UTC (same as lib/master-agent.js)
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

/** null = no ceiling. Junk is 'off': an unreadable ceiling must never open anything. */
export function envCeiling(env = process.env) {
  const m = String(env.MASTER_AGENT_MODE ?? '').trim().toLowerCase();
  if (!m) return null;
  return MODES.includes(m) ? m : 'off';
}
export const clampMode = (mode, ceiling) => (!ceiling || RANK[mode] <= RANK[ceiling] ? mode : ceiling);

// ── the mode, as the cron and the queue read it ───────────────────────────────────────────────────────────────────────────

let cache = null;
export const clearMasterModeCache = () => { cache = null; };

/** The mode in force right now: the stored choice, clamped by the env ceiling. Cached for 30 s (cleared whenever it is written). */
export async function getMasterMode({ query = dbQuery, env = process.env, nowMs = Date.now() } = {}) {
  const ceiling = envCeiling(env);
  if (ceiling === 'off') return 'off'; // locked: nothing to read
  const cacheable = query === dbQuery;
  if (cacheable && cache && cache.ceiling === ceiling && nowMs - cache.at < CACHE_MS) return cache.mode;
  let stored = 'off';
  try {
    const s = await getSetting(MODE_KEY, { query });
    if (s && MODES.includes(s.value)) stored = s.value;
  } catch { return 'off'; }
  const mode = clampMode(stored, ceiling);
  if (cacheable) cache = { mode, ceiling, at: nowMs };
  return mode;
}

// ── a failed plan is recorded so "no failed plans" can be checked later ───────────────────────────────────────────────────

/** Called by the scheduled pass when planning raised an error. Keeps the last WINDOW_DAYS days. Never throws. */
export async function recordPlanError({ day, message, query = dbQuery } = {}) {
  try {
    const cur = (await getSetting(PLAN_ERRORS_KEY, { query }))?.value || {};
    const next = { ...cur, [day]: String(message || 'error').slice(0, 160) };
    const keep = Object.keys(next).sort().slice(-WINDOW_DAYS);
    await putSettingQuiet(PLAN_ERRORS_KEY, Object.fromEntries(keep.map((k) => [k, next[k]])), { query });
  } catch { /* bookkeeping must never break the pass it describes */ }
}

// ── readiness for 'on' ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pure. Which shadow days FAILED. A shadow day fails when ANY of these holds:
 *   1. a plan raised an error that day (recorded by recordPlanError);
 *   2. one of its planned rows is not an untouched shadow row (state other than 'skipped', or an error on it);
 *   3. it planned fewer projects than were expected: a project planned on an EARLIER shadow day in the window, and still
 *      schedulable now, is missing from that day.
 * Rule 3 is deliberately day-over-day rather than "against everything eligible today": a project connected this morning was never
 * part of yesterday's plan, and calling yesterday incomplete for that would block switching on for a reason nobody could act on.
 *
 * rows: [{ day, site_id, odd }] (one per planned project per shadow day); schedulableNow: Set of site ids; planErrors: { day: message }.
 * Returns { shadowDays: [days], failedDays: [days], reasons: { day: [reason] } }.
 */
export function evaluateShadowDays(rows, schedulableNow, planErrors = {}, { from = '0000-00-00' } = {}) {
  const byDay = new Map();
  for (const r of rows) { if (r.day >= from) { if (!byDay.has(r.day)) byDay.set(r.day, { sites: new Set(), odd: false }); const d = byDay.get(r.day); d.sites.add(r.site_id); if (r.odd) d.odd = true; } }
  const days = [...byDay.keys()].sort();
  const failed = new Map();
  const fail = (day, why) => { if (!failed.has(day)) failed.set(day, []); failed.get(day).push(why); };
  const seen = new Set();
  for (const day of days) {
    const d = byDay.get(day);
    if (d.odd) fail(day, 'a planned job was not an untouched shadow row');
    const missing = [...seen].filter((id) => schedulableNow.has(id) && !d.sites.has(id));
    if (missing.length) fail(day, `${missing.length} project${missing.length === 1 ? '' : 's'} planned earlier were missing`);
    for (const id of d.sites) seen.add(id);
  }
  for (const [day, message] of Object.entries(planErrors)) if (day >= from) fail(day, `plan error: ${message}`);
  return { shadowDays: days, failedDays: [...failed.keys()].sort(), reasons: Object.fromEntries(failed) };
}

// siteIds (optional) limits the look to those projects: used by tests that share one database with other tests, never by the page.
export async function loadReadiness({ query = dbQuery, now = new Date(), siteIds = null } = {}) {
  const today = ymd(now);
  let from = ymd(addDays(now, -WINDOW_DAYS));
  // The window starts when Shadow was last switched ON, so a bad day from an earlier attempt does not linger forever.
  const history = await listChanges(MODE_KEY, { limit: 20, query }).catch(() => []);
  const lastToShadow = history.find((h) => h.to === 'shadow');
  if (lastToShadow && ymd(lastToShadow.at) > from) from = ymd(lastToShadow.at);

  const [{ rows: jobs }, { rows: sites }, errs, reg] = await Promise.all([
    query(`SELECT run_day::text AS day, site_id, (state <> 'skipped' OR error IS NOT NULL) AS odd
             FROM instance_jobs WHERE kind = 'daily' AND mode = 'shadow' AND run_day >= $1::date AND run_day <= $2::date AND ($3::int[] IS NULL OR site_id = ANY($3::int[]))`, [from, today, siteIds]).catch(() => ({ rows: [] })),
    query(`SELECT * FROM sites WHERE status = 'active'`).catch(() => ({ rows: [] })),
    getSetting(PLAN_ERRORS_KEY, { query }).then((s) => s?.value || {}).catch(() => ({})),
    query(`SELECT to_regclass('public.instance_jobs') IS NOT NULL AS jobs, to_regclass('public.platform_settings') IS NOT NULL AS settings`).then((r) => r.rows[0]).catch(() => ({ jobs: false, settings: false })),
  ]);
  const schedulableNow = new Set(sites.filter(isSchedulable).filter((s) => !siteIds || siteIds.includes(s.id)).map((s) => s.id));
  const ev = evaluateShadowDays(jobs, schedulableNow, errs, { from });
  const shadowDays = ev.shadowDays.length;
  const failedPlans = ev.failedDays.length;
  const migrationOk = Boolean(reg.jobs && reg.settings);
  const enough = shadowDays >= REQUIRED_SHADOW_DAYS;
  const checks = [
    { key: 'shadow-days', label: `At least ${REQUIRED_SHADOW_DAYS} days of safe start`, ok: enough,
      detail: enough ? `${shadowDays} days recorded.` : `${shadowDays} ${shadowDays === 1 ? 'day' : 'days'} so far. ${REQUIRED_SHADOW_DAYS - shadowDays} more before it can go live.` },
    { key: 'no-failed-plans', label: 'No failed plans', ok: failedPlans === 0,
      detail: failedPlans === 0 ? 'Every plan finished and covered every connected project.' : `${failedPlans} failed ${failedPlans === 1 ? 'day' : 'days'}: ${ev.failedDays.join(', ')}.` },
    { key: 'migration', label: 'Database is up to date', ok: migrationOk, detail: migrationOk ? 'The queue and settings tables are in place.' : 'A required table is missing. Apply the latest migrations.' },
    { key: 'production-proof', label: 'Not yet proven in production', ok: null, detail: 'Running jobs through the queue has not been tried on real clients. Watch the first day.' },
  ];
  return {
    shadowDays, requiredShadowDays: REQUIRED_SHADOW_DAYS, failedPlans, migrationOk, checks,
    ready: enough && failedPlans === 0 && migrationOk,
  };
}

const notReadyReason = (r) => (!r.migrationOk ? 'A required table is missing. Apply the latest migrations first.'
  : r.shadowDays < REQUIRED_SHADOW_DAYS ? `Going live needs at least ${REQUIRED_SHADOW_DAYS} days of safe start with no failed plans (${r.shadowDays} so far).`
  : `Going live needs no failed plans, and ${r.failedPlans} day${r.failedPlans === 1 ? '' : 's'} failed in safe start.`);

// ── what the page shows, and the switch itself ────────────────────────────────────────────────────────────────────────────

/** mode, ceiling, locked, canSwitch, readiness and history: the control half of GET /platform/master-agent. */
export async function loadMasterControl({ query = dbQuery, env = process.env, now = new Date(), mode, siteIds = null } = {}) {
  const ceiling = envCeiling(env);
  const [current, readiness, history] = await Promise.all([
    mode ? Promise.resolve(mode) : getMasterMode({ query, env }),
    loadReadiness({ query, now, siteIds }),
    listChanges(MODE_KEY, { limit: 10, query }).catch(() => []),
  ]);
  const locked = ceiling === 'off';
  const ceilingMsg = (m) => `The server setting MASTER_AGENT_MODE=${ceiling} does not allow ${m}. Change it on the server first.`;
  const canSwitch = {
    off: { ok: true },
    shadow: locked || (ceiling && RANK.shadow > RANK[ceiling]) ? { ok: false, reason: ceilingMsg('shadow') } : { ok: true },
    on: ceiling && RANK.on > RANK[ceiling] ? { ok: false, reason: ceilingMsg('on') } : readiness.ready ? { ok: true } : { ok: false, reason: notReadyReason(readiness) },
  };
  const { ready, ...readinessOut } = readiness;
  return {
    mode: current, ceiling, locked, canSwitch, readiness: readinessOut,
    autoBaseline: await autoBaselineStatus({ query, now, env }),
    history: history.map((h) => ({ at: h.at, by: h.by, from: h.from ?? 'off', to: h.to })),
  };
}

/** Validates and writes the mode. Throws MasterControlError (400 BAD_MODE, 409 CEILING, 409 NOT_READY). */
export async function setMasterMode(mode, { by = null, email = null, query = dbQuery, env = process.env, now = new Date(), siteIds = null } = {}) {
  if (!MODES.includes(mode)) throw new MasterControlError('BAD_MODE', 'Mode must be off, shadow or on.', 400);
  const ceiling = envCeiling(env);
  if (ceiling && RANK[mode] > RANK[ceiling]) throw new MasterControlError('CEILING', `The server setting MASTER_AGENT_MODE=${ceiling} does not allow ${mode}. Change it on the server first.`);
  if (mode === 'on') {
    const r = await loadReadiness({ query, now, siteIds });
    if (!r.ready) throw new MasterControlError('NOT_READY', notReadyReason(r));
  }
  const stored = (await getSetting(MODE_KEY, { query }))?.value ?? 'off';
  if (stored === mode) { clearMasterModeCache(); return { changed: false, from: stored, to: mode }; } // no duplicate history row
  await setSetting(MODE_KEY, mode, { by, email, query });
  // The moment it goes live is the cut-off for automatic baselines: only projects created after it get one (lib/auto-baseline.js).
  if (mode === 'on') await putSettingQuiet(LIVE_SINCE_KEY, now.toISOString(), { query });
  clearMasterModeCache();
  return { changed: true, from: stored, to: mode };
}

/** The plan-versus-existing detail the shadow table draws. Counts, names and durations only. */
export async function shadowPlanDetail({ query = dbQuery, now = new Date(), siteIds = null } = {}) {
  const today = ymd(now);
  const [{ rows: plan }, { rows: legacy }, { rows: perDay }, { rows: ran }] = await Promise.all([
    query(`SELECT j.site_id, s.name, j.priority, j.estimate_ms FROM instance_jobs j JOIN sites s ON s.id = j.site_id
            WHERE j.kind = 'daily' AND j.run_day = $1::date AND ($2::int[] IS NULL OR j.site_id = ANY($2::int[])) ORDER BY j.priority, j.site_id`, [today, siteIds]),
    query(`SELECT site_id, (extract(epoch FROM (max(created_at) - min(created_at))) * 1000)::bigint AS ms
             FROM agent_runs WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date AND ($2::int[] IS NULL OR site_id = ANY($2::int[])) GROUP BY site_id`, [today, siteIds]),
    query(`SELECT run_day::text AS day, count(*)::int AS planned FROM instance_jobs
            WHERE kind = 'daily' AND run_day > $1::date - 7 AND run_day <= $1::date AND ($2::int[] IS NULL OR site_id = ANY($2::int[])) GROUP BY run_day`, [today, siteIds]),
    query(`SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(DISTINCT site_id)::int AS n FROM agent_runs
            WHERE (created_at AT TIME ZONE 'UTC')::date > $1::date - 7 AND (created_at AT TIME ZONE 'UTC')::date <= $1::date AND ($2::int[] IS NULL OR site_id = ANY($2::int[])) GROUP BY 1`, [today, siteIds]),
  ]);
  const legacyMs = new Map(legacy.map((r) => [r.site_id, Number(r.ms) > 0 ? Number(r.ms) : null]));
  const planned = new Map(perDay.map((r) => [r.day, r.planned]));
  const ranBy = new Map(ran.map((r) => [r.day, r.n]));
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(now, i - 6))).map((day) => ({ day, planned: planned.get(day) || 0, legacyRan: ranBy.get(day) || 0 }));
  return {
    projects: plan.map((p, i) => ({ siteId: p.site_id, name: p.name, order: p.priority ?? i + 1, plannedMs: p.estimate_ms ?? null, legacyMs: legacyMs.get(p.site_id) ?? null })),
    days,
  };
}
