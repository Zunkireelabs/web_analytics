// The in-app weekly / monthly report body: the same sections, built from the same arithmetic (doc-model.js) as the
// branded Google Doc, so the page, the Doc and the PDF never disagree. Reads only; no model calls. Anything we do
// not have (no baseline, a single audit) is left out rather than made up.
import { getDailySeries, getRangeTopQueries, getHealthScoreOnOrBefore } from '../store/read.js';
import { getBaselineReport } from '../store/baseline-reports.js';
import { getFirstCompletedAuditRun, getLatestCompletedAuditRun, getAuditPageFindings } from '../store/audit-runs.js';
import { query } from '../db.js';
import { buildWorkItems } from './work-catalogue.js';
import { pageScoreSection } from './page-score.js';
import { periodStats, tilesFor, headlineFor, bettermentTable, topSearchesSection, fmt } from './doc-model.js';
import { previousWeek, previousMonth, monthBounds, shiftMonth } from '../util/dates.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => String(d).slice(0, 10);
const dayName = (d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()];
const shortDate = (d) => { const x = new Date(`${d}T00:00:00Z`); return `${SHORT_MONTHS[x.getUTCMonth()]} ${String(x.getUTCDate()).padStart(2, '0')}`; };
const shift = (d, days) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
const pos = (v) => (v == null ? '—' : v.toFixed(1));

// Mon–Sun weeks clipped to the month (same split as monthly-doc.js).
export function monthWeeks(start, end) {
  const weeks = [];
  let cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    const dow = cur.getUTCDay();
    const sun = new Date(cur); sun.setUTCDate(cur.getUTCDate() + (dow === 0 ? 0 : 7 - dow));
    weeks.push({ start: cur.toISOString().slice(0, 10), end: (sun <= last ? sun : last).toISOString().slice(0, 10) });
    cur = new Date(sun); cur.setUTCDate(sun.getUTCDate() + 1);
  }
  return weeks;
}

async function scoreSectionFor(siteId) {
  const [baselineRun, latestRun] = await Promise.all([getFirstCompletedAuditRun(siteId), getLatestCompletedAuditRun(siteId)]);
  if (!baselineRun || !latestRun || baselineRun.id === latestRun.id) return null;
  const [b, l] = await Promise.all([getAuditPageFindings(baselineRun.id, { limit: 5000 }), getAuditPageFindings(latestRun.id, { limit: 5000 })]);
  return pageScoreSection({ baselineRun, latestRun, baselineFindings: b, latestFindings: l });
}

// What went live in the period, in the standard client wording (work-catalogue.js). Counts only: whether a fix moved
// clicks is measured weeks later (fix_impact) and is never claimed here.
async function didFor(siteId, start, end) {
  const { rows } = await query(
    `SELECT action_type, status FROM drafts WHERE site_id = $1 AND status = 'implemented'
        AND implemented_at >= $2::date AND implemented_at < ($3::date + 1)`, [siteId, start, end]);
  return buildWorkItems({ drafts: rows, maxPlanned: 0 }).filter((i) => i.status === 'live').map((i) => ({ title: i.title, did: i.did, why: i.why }));
}

export async function buildInAppModel(site, period) {
  const weekly = period === 'weekly';
  let start, end, prevStart, prevEnd;
  if (weekly) {
    ({ start, end } = previousWeek(site.timezone));
    prevStart = shift(start, -7); prevEnd = shift(end, -7);
  } else {
    const { year, month } = previousMonth(site.timezone);
    ({ start, end } = monthBounds(year, month));
    const p = shiftMonth(year, month, -1);
    ({ start: prevStart, end: prevEnd } = monthBounds(p.year, p.month));
  }
  const [series, prevSeries, topQueries, baselineRow, health, scoreSection, did] = await Promise.all([
    getDailySeries(site.id, start, end), getDailySeries(site.id, prevStart, prevEnd),
    getRangeTopQueries(site.id, start, end, weekly ? 5 : 10), getBaselineReport(site.id),
    getHealthScoreOnOrBefore(site.id, end), scoreSectionFor(site.id), didFor(site.id, start, end).catch(() => []),
  ]);
  const cur = periodStats(series);
  const prev = prevSeries.length ? periodStats(prevSeries) : null;
  const vs = weekly ? 'prior week' : 'prior month';
  const better = bettermentTable({
    baseline: baselineRow?.kpi_snapshot, baselineAt: baselineRow?.generated_at, periodEnd: end,
    cur, prev, currentHealth: health, labels: weekly ? { prev: 'Last week', cur: 'This week' } : { prev: 'Last month', cur: 'This month' },
  });

  let bars; let breakdown;
  if (weekly) {
    bars = series.map((r) => ({ label: dayName(ymd(r.date)), value: Number(r.clicks || 0), valueText: fmt(r.clicks) }));
    breakdown = { title: 'Day by day', sub: 'Search and visits for each day of the week', head: ['Day', 'Impressions', 'Clicks', 'Position', 'Users'],
      rows: [...series.map((r) => [`${dayName(ymd(r.date))} ${ymd(r.date).slice(8)}`, fmt(r.impressions), fmt(r.clicks), r.position == null ? '—' : Number(r.position).toFixed(1), fmt(r.users)]),
        ['Week', fmt(cur.impressions), fmt(cur.clicks), pos(cur.position), fmt(cur.users)]] };
  } else {
    const weeks = monthWeeks(start, end).map((w) => ({
      label: `${shortDate(w.start)} – ${shortDate(w.end)}`,
      s: periodStats(series.filter((r) => ymd(r.date) >= w.start && ymd(r.date) <= w.end)),
    }));
    bars = weeks.map((w) => ({ label: w.label, value: w.s.clicks, valueText: fmt(w.s.clicks) }));
    breakdown = { title: 'Week by week', sub: 'Search and visits for each week of the month', head: ['Week', 'Impressions', 'Clicks', 'Position', 'Users'],
      rows: [...weeks.map((w) => [w.label, fmt(w.s.impressions), fmt(w.s.clicks), pos(w.s.position), fmt(w.s.users)]),
        ['Month', fmt(cur.impressions), fmt(cur.clicks), pos(cur.position), fmt(cur.users)]] };
  }

  const toSection = (s) => (s?.table ? { title: s.title, sub: s.sub, head: s.table.head, rows: s.table.rows } : null);
  return {
    headline: headlineFor(cur, prev, weekly ? 'this week' : 'this month', `the ${vs}`),
    tiles: tilesFor(cur, prev, vs),
    barsTitle: weekly ? 'Clicks by day' : 'Clicks, week by week',
    bars,
    did,
    sections: [breakdown, toSection(better), toSection(scoreSection), toSection(topSearchesSection(topQueries))].filter(Boolean),
  };
}
