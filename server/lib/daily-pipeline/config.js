// Settings and pure time helpers for the unified daily pipeline. Nothing here touches the database or the clock on its own.
//
// THE FLAGS. Everything about the pipeline is off unless DAILY_PIPELINE_ENABLED is exactly 'true', so a deploy of this code
// changes no behaviour until someone turns it on. SHIP_PREPARED_ONLY is a second, separate flag on purpose: until the prepare
// lane really exists, the shipping run keeps generating inline as it does today.
//
// TIME. The pipeline's own schedules run in PIPELINE_TZ (Asia/Kathmandu) through node-cron's per-schedule timezone option.
// The global TZ environment variable is never changed: every other job keeps running in it.

export const STAGES = Object.freeze(['research', 'design-baseline', 'analyst', 'repair', 'generate', 'design-live', 'prepare']);

// Stages whose failure stops the project's later stages for the day. A later stage needs what an earlier one produced; the
// others are best-effort and the project carries on without them.
export const REQUIRED_STAGES = Object.freeze(['research']);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function pipelineConfig(env = process.env) {
  return {
    enabled: env.DAILY_PIPELINE_ENABLED === 'true',
    timezone: env.PIPELINE_TZ || 'Asia/Kathmandu',
    startCron: env.PIPELINE_START_CRON || '30 5 * * *',
    // The Design Agent is quiet until this hour; its live checks are queued from then on.
    liveDesignFrom: env.PIPELINE_LIVE_DESIGN_FROM || '07:45',
    // No new project or stage starts after this. Anything unfinished stays queued for the next cycle.
    prepDeadline: env.PIPELINE_PREP_DEADLINE || '10:50',
    // A stage already running at the deadline may finish for this long, then the pass stops waiting for it.
    graceMs: num(env.PIPELINE_GRACE_MS, 5 * 60 * 1000),
    // Kept for compatibility, no longer used to wait inside a pass: the analyst stage is a readiness gate (it starts only once the
    // Data Analyst's findings_complete marker exists, never uses stale findings, and is deferred with its reason at the deadline).
    analystWaitUntil: env.PIPELINE_ANALYST_WAIT_UNTIL || '06:30',
    maxAttempts: num(env.PIPELINE_MAX_ATTEMPTS, 3),
    maxCorrectionLoops: num(env.PIPELINE_MAX_CORRECTION_LOOPS, 2),
    // how many queued fixes one project prepares per pass (the day's budget is still decided by the auto-remediation selection)
    prepareLimit: num(env.PIPELINE_PREPARE_LIMIT, 60),
    perSiteBudgetMs: num(env.PIPELINE_SITE_BUDGET_MS, 40 * 60 * 1000),
    shipPreparedOnly: env.SHIP_PREPARED_ONLY === 'true',
    // the ONE consolidated ship run; nothing ships before it (ship.js shipPreparedForAllSites)
    shipAt: env.PIPELINE_SHIP_AT || '11:00',
    shipTimezone: env.SHIP_CRON_TIMEZONE || null,
  };
}

// 'HH:MM' -> minutes since midnight, or null when it is not a clock time.
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

// The wall-clock parts of `now` in an IANA timezone.
function partsIn(timezone, now) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second) };
}

// Today's date in the timezone, as YYYY-MM-DD. This is the pipeline's `run_date`.
export function runDateIn(timezone, now = new Date()) {
  return partsIn(timezone, now).date;
}

// The instant (epoch ms) at which today's `hhmm` happens in the timezone, counted from `now`. When the clock is already past it,
// this is in the past, which is what lets a caller ask "has the deadline gone by?" with one comparison.
export function todayAt(hhmm, timezone, now = new Date()) {
  const target = minutesOf(hhmm);
  if (target == null) return null;
  const { minutes, seconds } = partsIn(timezone, now);
  return now.getTime() + (target - minutes) * 60000 - seconds * 1000;
}

// Minutes since midnight of `now` in the timezone (used by the 11:00 ship guard).
export const minutesIn = (timezone, now = new Date()) => partsIn(timezone, now).minutes;

export const pastDeadline = (deadlineAt, now = Date.now()) => deadlineAt != null && now >= deadlineAt;
