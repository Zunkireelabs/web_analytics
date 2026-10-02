// Trend Radar runs once per calendar month, never weekly: a trend article is
// a monthly editorial decision, and each run costs an LLM call plus ~6 feed
// fetches per site. "Per calendar month" (not "30 days since last run") is
// deliberate — a run on Oct 2 must not push the next one to Nov 1 or Nov 2
// by drift; it is simply due again once November begins.
//
// Only a successful run counts. An errored or insufficient-data run (feeds
// unreachable, no industry yet) leaves the month unserved, so the cron's
// retry days (see cron.js) and a manual re-run can still fill it.

function monthKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}`;
}

// lastRun: { status, created_at } | null/undefined (store/agent-runs.js shape).
// enabledFrom: 'YYYY-MM' — nothing is due before that calendar month (rollout
// gate, see job.js). Judged in the same timezone as everything else.
export function trendRadarDue(lastRun, { now = new Date(), timeZone = 'UTC', enabledFrom = null } = {}) {
  if (enabledFrom && monthKey(now, timeZone) < enabledFrom) return false;
  if (!lastRun || lastRun.status !== 'ok') return true;
  return monthKey(new Date(lastRun.created_at), timeZone) !== monthKey(now, timeZone);
}
