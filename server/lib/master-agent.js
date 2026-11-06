import { query as dbQuery } from '../db.js';
import { isSchedulable } from './instance-lifecycle.js';
import { runSiteWithDeadline, SITE_RUN_TIMEOUT_MS, SITE_RUN_GRACE_MS } from './site-run.js';
import { jobLockInfo, jobKeyFor } from './job-lock.js';
import { reconcileInstances } from './agent-factory.js';
import { getMasterMode } from './master-agent-control.js';

// THE MASTER AGENT (P3). One queue of per-project jobs, run by a small worker pool, in place of one sequential loop over every site.
//
// What it owns: WHEN each project's daily pipeline runs, in WHAT order (fairness), HOW MANY at once (resource limits), what happens
// when one fails (retry, lease, timeout) and whether the platform is healthy (health()).
// What it does NOT own: what a job does. The default executor calls job.js runDailyJobForSite(site), the same function the existing
// loop calls, so detection, ranking, the decision engine and shipping are untouched. Shipping keeps its own cron (per-site locks,
// per-credential locks and the atomic daily ceiling already exist); only the daily detection pipeline is queued here.
//
// MODES. The mode is chosen on the Platform page (lib/master-agent-control.js, migration 246) and read fresh at run time, so a change
// needs no restart. The environment variable MASTER_AGENT_MODE is now only a CEILING on that choice (unset = none, 'off' = locked off).
// masterMode(env) below is the env-only reading, kept for tests and scripts; the scheduler uses getMasterMode().
//   off     (default) does nothing at all. The existing cron is the only scheduler.
//   shadow  plans the day and records what it WOULD run and how long that would take, runs nothing, and shows how that compares with
//           what the existing loop actually did. This is the safe way to prove the queue before it is trusted.
//   on      plans, then runs the jobs. It refuses to start while the existing daily run holds its lock, and the existing daily cron
//           must be switched off with LEGACY_DAILY_JOB_DISABLED=true, otherwise a day would run twice.
//
// Defaults reproduce today's behaviour: one worker, one browser slot. Raising them is a deliberate, measured step.

export const MASTER_MODES = Object.freeze(['off', 'shadow', 'on']);
export function masterMode(env = process.env) {
  const m = String(env.MASTER_AGENT_MODE || 'off').toLowerCase();
  return MASTER_MODES.includes(m) ? m : 'off';
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const limits = (env = process.env) => ({
  concurrency: Math.floor(num(env.MASTER_AGENT_CONCURRENCY, 1)),
  browserSlots: Math.floor(num(env.MASTER_BROWSER_SLOTS, 1)),
  jobTimeoutMs: num(env.MASTER_JOB_TIMEOUT_MS, SITE_RUN_TIMEOUT_MS),
  leaseMs: num(env.MASTER_LEASE_MS, 10 * 60 * 1000),
});

// Every kind of queued work, and which scarce resources one job of that kind holds while it runs.
export const KINDS = Object.freeze({
  daily: { label: 'Daily pipeline', resources: ['browser'], defaultEstimateMs: 12 * 60 * 1000 },
});

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BACKOFF_MIN = [5, 15, 45];
export const backoffMs = (attempt) => BACKOFF_MIN[Math.min(Math.max(attempt, 1), BACKOFF_MIN.length) - 1] * 60 * 1000;

// Fairness: a project that has never succeeded goes first, then the one that has waited longest; ties break by a daily rotation so
// the same project is not always last. Pure. lastSuccess: Map siteId -> Date|string.
export function orderForFairness(sites, lastSuccess, now = new Date()) {
  const day = Math.floor(now.getTime() / 86400000);
  const rank = (s) => { const t = lastSuccess.get(s.id); return t ? new Date(t).getTime() : -Infinity; };
  const sorted = [...sites].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  // Projects with the same wait (all of them on the first day, or after a clean day) take turns going first, like site-run's
  // rotateForToday: within each group of ties the starting point moves by one each day.
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i; while (j < sorted.length && rank(sorted[j]) === rank(sorted[i])) j++;
    const group = sorted.slice(i, j); const k = group.length > 1 ? day % group.length : 0;
    out.push(...group.slice(k), ...group.slice(0, k));
    i = j;
  }
  return out;
}

// Pure. How long a set of jobs takes with `concurrency` workers and `browserSlots` browser slots. Jobs of a kind that holds the browser
// can only run as many at once as there are slots, however many workers exist. Longest-job-first bound: never below the longest job.
export function estimateMakespanMs(estimatesMs, { concurrency = 1, browserSlots = 1, needsBrowser = true } = {}) {
  if (!estimatesMs.length) return 0;
  const parallel = Math.max(1, needsBrowser ? Math.min(concurrency, browserSlots) : concurrency);
  const total = estimatesMs.reduce((a, b) => a + b, 0);
  return Math.max(Math.ceil(total / parallel), Math.max(...estimatesMs));
}

// A counting semaphore set. acquireAll takes several resources in a fixed order, so two jobs can never deadlock each other.
export class Resources {
  constructor(caps = {}) { this.caps = { ...caps }; this.used = {}; this.waiters = []; }
  _can(keys) { return keys.every((k) => (this.used[k] || 0) < (this.caps[k] ?? Infinity)); }
  async acquireAll(keys) {
    const ks = [...new Set(keys)].sort();
    while (!this._can(ks)) await new Promise((res) => this.waiters.push(res));
    for (const k of ks) this.used[k] = (this.used[k] || 0) + 1;
    let released = false;
    return () => {
      if (released) return; released = true;
      for (const k of ks) this.used[k] -= 1;
      const w = this.waiters.splice(0); for (const f of w) f();
    };
  }
}

// ── planning ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const dayOf = (now) => now.toISOString().slice(0, 10); // the platform's day is UTC; one schedule, one day

// Average wall-clock span of a project's recent daily runs, from what the existing loop already recorded.
export async function estimateMsBySite(siteIds, { query = dbQuery } = {}) {
  if (!siteIds.length) return new Map();
  const { rows } = await query(
    `SELECT site_id, avg(span)::int AS ms FROM (
       SELECT site_id, (created_at AT TIME ZONE 'UTC')::date AS d, extract(epoch FROM (max(created_at) - min(created_at))) * 1000 AS span
         FROM agent_runs WHERE site_id = ANY($1) AND created_at > now() - interval '8 days' AND created_at < date_trunc('day', now())
        GROUP BY 1, 2 HAVING count(*) >= 3) x GROUP BY site_id`, [siteIds]);
  return new Map(rows.filter((r) => r.ms > 0).map((r) => [r.site_id, r.ms]));
}

/** Creates today's jobs, one per eligible project. Safe to run again: the (project, kind, day) key makes a second plan a no-op. */
export async function planDay({ mode = 'on', now = new Date(), query = dbQuery, kind = 'daily', siteIds = null } = {}) {
  if (!['shadow', 'on'].includes(mode)) return { planned: 0, existing: 0, jobs: [] };
  const { rows: all } = await query(`SELECT * FROM sites WHERE status = 'active'`);
  const sites = all.filter(isSchedulable).filter((s) => !siteIds || siteIds.includes(s.id)); // siteIds: plan just these projects
  const ids = sites.map((s) => s.id);
  const [{ rows: ok }, est] = await Promise.all([
    ids.length ? query(`SELECT site_id, max(finished_at) AS at FROM instance_jobs WHERE site_id = ANY($1) AND state = 'succeeded' GROUP BY site_id`, [ids]) : { rows: [] },
    estimateMsBySite(ids, { query }),
  ]);
  const ordered = orderForFairness(sites, new Map(ok.map((r) => [r.site_id, r.at])), now);
  const day = dayOf(now);
  let planned = 0;
  for (const [i, s] of ordered.entries()) {
    const estimate = est.get(s.id) ?? KINDS[kind].defaultEstimateMs;
    const state = mode === 'shadow' ? 'skipped' : 'queued';
    const result = mode === 'shadow' ? JSON.stringify({ wouldRun: true, position: i + 1 }) : null;
    // A shadow row left by an earlier shadow plan today becomes a real job when the mode is 'on'; nothing else is ever overwritten.
    const r = await query(
      `INSERT INTO instance_jobs (site_id, kind, run_day, state, mode, priority, estimate_ms, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (site_id, kind, run_day) DO UPDATE
         SET state = EXCLUDED.state, mode = EXCLUDED.mode, priority = EXCLUDED.priority, estimate_ms = EXCLUDED.estimate_ms, result = NULL
         WHERE instance_jobs.mode = 'shadow' AND EXCLUDED.mode = 'on'
       RETURNING id`, [s.id, kind, day, state, mode, i + 1, estimate, result]);
    if (r.rows.length) planned++;
  }
  return { planned, existing: ordered.length - planned, total: ordered.length, day };
}

// ── claiming, running, finishing ────────────────────────────────────────────────────────────────────────────────────────────

/** Returns one job to run, or null. Atomic: two workers can never take the same one. Also re-takes a job whose worker died. */
export async function claimNext({ workerId, leaseMs = limits().leaseMs, query = dbQuery, now = new Date(), siteIds = null } = {}) {
  const { rows } = await query(
    `UPDATE instance_jobs j SET state = 'running', locked_by = $1, lease_expires_at = now() + ($2 || ' milliseconds')::interval,
            attempts = j.attempts + 1, started_at = now(), error = NULL
      WHERE j.id = (
        SELECT id FROM instance_jobs
         WHERE mode = 'on' AND attempts < max_attempts AND run_day = $3::date AND ($4::int[] IS NULL OR site_id = ANY($4::int[]))
           AND ((state = 'queued' AND run_after <= now()) OR (state = 'running' AND lease_expires_at < now()))
         ORDER BY priority, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING j.*`, [workerId, leaseMs, dayOf(now), siteIds]);
  return rows[0] || null;
}

/** A running job whose worker died and whose attempts are used up is closed as failed, not left "running" forever. */
export async function reapExhausted({ query = dbQuery, now = new Date() } = {}) {
  const { rowCount } = await query(
    `UPDATE instance_jobs SET state = 'failed', finished_at = now(), error = 'The worker stopped and no attempts were left.'
      WHERE state = 'running' AND lease_expires_at < now() AND attempts >= max_attempts AND run_day = $1::date`, [dayOf(now)]);
  return rowCount;
}

const heartbeat = (id, workerId, leaseMs, query) =>
  query(`UPDATE instance_jobs SET lease_expires_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND locked_by = $2 AND state = 'running'`, [id, workerId, leaseMs]);

async function finish(id, workerId, { state, error = null, result = null, durationMs }, query) {
  await query(
    `UPDATE instance_jobs SET state = $3, finished_at = now(), duration_ms = $4, error = $5, result = $6::jsonb, locked_by = NULL, lease_expires_at = NULL
      WHERE id = $1 AND locked_by = $2`, [id, workerId, state, durationMs, error ? String(error).slice(0, 500) : null, result ? JSON.stringify(result) : null]);
}

async function requeue(id, workerId, error, delayMs, query) {
  await query(
    `UPDATE instance_jobs SET state = 'queued', run_after = now() + ($3 || ' milliseconds')::interval, error = $4, locked_by = NULL, lease_expires_at = NULL
      WHERE id = $1 AND locked_by = $2`, [id, workerId, delayMs, String(error).slice(0, 500)]);
}

// The existing daily run holds this lock while it works; running both would run a day twice.
export const legacyDailyRunning = async () => Boolean(await jobLockInfo(jobKeyFor('daily-job', 'all-sites')));

async function defaultExecutor(job, site, { isAborted }) {
  const { runDailyJobForSite } = await import('../job.js');
  return runDailyJobForSite(site, { isAborted });
}

/**
 * Runs one claimed job to a recorded end. Never throws.
 * success -> succeeded; error -> queued again with backoff while attempts remain, else failed; overran -> timed_out (not retried,
 * the same choice the existing loop makes: it is left for tomorrow, so a hung project cannot block the others twice).
 */
export async function runJob(job, { workerId, executor = defaultExecutor, resources, query = dbQuery, timeoutMs = limits().jobTimeoutMs, graceMs = SITE_RUN_GRACE_MS, leaseMs = limits().leaseMs } = {}) {
  const started = Date.now();
  const hb = setInterval(() => { heartbeat(job.id, workerId, leaseMs, query).catch(() => {}); }, Math.max(1000, Math.floor(leaseMs / 3)));
  hb.unref?.();
  let release = () => {};
  try {
    const { rows } = await query('SELECT * FROM sites WHERE id = $1', [job.site_id]);
    const site = rows[0];
    if (!site || !isSchedulable(site)) {
      await finish(job.id, workerId, { state: 'skipped', result: { reason: 'no longer eligible' }, durationMs: Date.now() - started }, query);
      return { id: job.id, state: 'skipped' };
    }
    release = await (resources ? resources.acquireAll(KINDS[job.kind]?.resources || []) : (() => () => {})());
    const run = await runSiteWithDeadline(site, ({ isAborted, deadlineAt }) => executor(job, site, { isAborted, deadlineAt }), { timeoutMs, graceMs, label: `master agent ${job.kind}` });
    const durationMs = Date.now() - started;
    if (run.ok) { await finish(job.id, workerId, { state: 'succeeded', result: { ok: true }, durationMs }, query); return { id: job.id, state: 'succeeded', durationMs }; }
    if (run.timedOut) { await finish(job.id, workerId, { state: 'timed_out', error: 'Ran past its time limit and was left behind.', durationMs }, query); return { id: job.id, state: 'timed_out', durationMs }; }
    const msg = String(run.error?.message || run.error);
    if (job.attempts < job.max_attempts) { await requeue(job.id, workerId, msg, backoffMs(job.attempts), query); return { id: job.id, state: 'queued', retry: true, error: msg }; }
    await finish(job.id, workerId, { state: 'failed', error: msg, durationMs }, query);
    return { id: job.id, state: 'failed', error: msg, durationMs };
  } catch (err) {
    await finish(job.id, workerId, { state: 'failed', error: err.message, durationMs: Date.now() - started }, query).catch(() => {});
    return { id: job.id, state: 'failed', error: err.message };
  } finally {
    clearInterval(hb);
    release();
  }
}

/**
 * Runs queued jobs with `concurrency` workers until none are left, the deadline passes, or the existing daily run starts.
 * Returns what happened. Never throws.
 */
export async function drain({ concurrency = limits().concurrency, browserSlots = limits().browserSlots, executor, query = dbQuery, now = () => new Date(), deadlineAt = null, maxJobs = Infinity, legacyRunning = legacyDailyRunning, timeoutMs, graceMs, leaseMs, siteIds = null } = {}) {
  const resources = new Resources({ browser: browserSlots });
  const out = { ran: 0, succeeded: 0, failed: 0, retried: 0, timedOut: 0, skipped: 0, stoppedReason: null, results: [] };
  await reapExhausted({ query, now: now() }).catch(() => {});
  let taken = 0;
  const loop = async (n) => {
    const workerId = `master:${process.pid}:${n}:${Math.random().toString(36).slice(2, 7)}`;
    for (;;) {
      if (out.stoppedReason) return;
      if (deadlineAt != null && Date.now() >= deadlineAt) { out.stoppedReason = out.stoppedReason || 'window-closed'; return; }
      if (taken >= maxJobs) return;
      if (await legacyRunning().catch(() => false)) { out.stoppedReason = 'legacy-daily-run-active'; return; }
      const job = await claimNext({ workerId, query, now: now(), leaseMs, siteIds });
      if (!job) return;
      taken++;
      const r = await runJob(job, { workerId, executor, resources, query, timeoutMs, graceMs, leaseMs });
      out.ran++; out.results.push(r);
      if (r.state === 'succeeded') out.succeeded++; else if (r.state === 'failed') out.failed++; else if (r.state === 'timed_out') out.timedOut++; else if (r.state === 'skipped') out.skipped++; else if (r.retry) out.retried++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => loop(i)));
  return out;
}

// ── the tick, health and the shadow report ─────────────────────────────────────────────────────────────────────────────────

/** One pass: keep the instances provisioned, plan the day, and (only in 'on') run it. */
export async function masterTick({ mode: modeIn, now = new Date(), query = dbQuery, executor, deadlineAt = null, factoryDeps = {}, siteIds = null } = {}) {
  const mode = modeIn ?? await getMasterMode({ query });
  if (mode === 'off') return { mode, skipped: 'off' };
  const out = { mode, day: dayOf(now) };
  // Only a live pass keeps instances provisioned: that can register an analyst client and record a memory version, which a shadow
  // pass (whose whole point is to change nothing) must not do.
  if (mode === 'on') out.instances = await reconcileInstances({ query, deps: factoryDeps, now }).catch((e) => ({ error: e.message }));
  out.plan = await planDay({ mode, now, query, siteIds });
  if (mode === 'on') {
    if (await legacyDailyRunning().catch(() => false)) { out.drain = { stoppedReason: 'legacy-daily-run-active', ran: 0 }; return out; }
    out.drain = await drain({ executor, query, deadlineAt, now: () => now, siteIds });
  }
  return out;
}

export async function health({ query = dbQuery, now = new Date(), mode: modeIn } = {}) {
  const mode = modeIn ?? await getMasterMode({ query });
  const day = dayOf(now);
  const [counts, stuck, oldest, last, failures] = await Promise.all([
    query(`SELECT state, count(*)::int AS n FROM instance_jobs WHERE run_day = $1::date GROUP BY state`, [day]).then((r) => r.rows),
    query(`SELECT count(*)::int AS n FROM instance_jobs WHERE state = 'running' AND lease_expires_at < now()`).then((r) => r.rows[0].n),
    query(`SELECT extract(epoch FROM (now() - min(run_after)))::int AS s FROM instance_jobs WHERE state = 'queued' AND mode = 'on'`).then((r) => r.rows[0].s),
    query(`SELECT max(finished_at) AS at FROM instance_jobs WHERE state IN ('succeeded','failed','timed_out')`).then((r) => r.rows[0].at),
    query(`SELECT site_id, state, left(error, 160) AS error FROM instance_jobs WHERE run_day = $1::date AND state IN ('failed','timed_out') ORDER BY id DESC LIMIT 10`, [day]).then((r) => r.rows),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c.state, c.n]));
  return {
    mode, day, limits: limits(),
    today: { queued: by.queued || 0, running: by.running || 0, succeeded: by.succeeded || 0, failed: by.failed || 0, timedOut: by.timed_out || 0, skipped: by.skipped || 0 },
    stuckRunning: stuck, oldestQueuedSeconds: oldest, lastFinishedAt: last, recentFailures: failures,
  };
}

/** Shadow comparison: what the queue planned for today against what the existing loop actually did. Read only. */
export async function shadowReport({ query = dbQuery, now = new Date(), l = limits() } = {}) {
  const day = dayOf(now);
  const [{ rows: planned }, { rows: legacy }] = await Promise.all([
    query(`SELECT site_id, priority, estimate_ms FROM instance_jobs WHERE run_day = $1::date AND kind = 'daily' ORDER BY priority`, [day]),
    query(`SELECT DISTINCT site_id FROM agent_runs WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date`, [day]),
  ]);
  const plannedIds = new Set(planned.map((p) => p.site_id)); const ranIds = new Set(legacy.map((r) => r.site_id));
  const est = planned.map((p) => p.estimate_ms || KINDS.daily.defaultEstimateMs);
  return {
    day, planned: planned.length, legacyRan: ranIds.size,
    plannedButLegacyDidNot: [...plannedIds].filter((i) => !ranIds.has(i)),
    legacyRanButNotPlanned: [...ranIds].filter((i) => !plannedIds.has(i)),
    estimatedMs: { sequentialToday: estimateMakespanMs(est, { concurrency: 1, browserSlots: 1 }), withCurrentLimits: estimateMakespanMs(est, { concurrency: l.concurrency, browserSlots: l.browserSlots }) },
  };
}
