// Trend Radar runs once per FORTNIGHT: a trend article is an editorial
// decision tied to what is moving in the client's field, and two weeks is long
// enough for real launches and shifts to accumulate and short enough that the
// topics are still news. Each run costs an LLM call plus ~8 feed fetches per
// site.
//
// Judged in calendar DAYS in the site's own timezone, never "14 x 24 hours
// since the last run": a run at 06:31 must not push the next one to 06:31
// two weeks later and miss that morning's cron by a minute. A site is due once
// INTERVAL_DAYS local dates have passed since the last successful run's local
// date. The cron fires daily and this decides, so a run that fails on its day
// is simply retried the next morning instead of costing a fortnight.
//
// Only a successful run counts. An errored or insufficient-data run (feeds
// unreachable, no industry yet) leaves the fortnight unserved.

export const TREND_INTERVAL_DAYS = Number(process.env.TREND_RADAR_INTERVAL_DAYS) || 14;

function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const monthKey = (date, timeZone) => localDate(date, timeZone).slice(0, 7);
const dayNumber = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

// lastRun: { status, created_at } | null/undefined (store/agent-runs.js shape).
// enabledFrom: 'YYYY-MM' — nothing is due before that calendar month (rollout
// gate, see job.js). Judged in the same timezone as everything else.
export function trendRadarDue(lastRun, { now = new Date(), timeZone = 'UTC', enabledFrom = null, intervalDays = TREND_INTERVAL_DAYS } = {}) {
  if (enabledFrom && monthKey(now, timeZone) < enabledFrom) return false;
  if (!lastRun || lastRun.status !== 'ok') return true;
  const since = dayNumber(localDate(now, timeZone)) - dayNumber(localDate(new Date(lastRun.created_at), timeZone));
  return since >= intervalDays;
}
