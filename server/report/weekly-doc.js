import { getDocs } from '../auth/google.js';
import { query } from '../db.js';
import { callLLM } from '../llm.js';
import { getDailySeries, getRangeTopQueries, getHealthScoreOnOrBefore } from '../store/read.js';
import { getBaselineReport } from '../store/baseline-reports.js';
import { getFirstCompletedAuditRun, getLatestCompletedAuditRun, getAuditPageFindings } from '../store/audit-runs.js';
import { pageScoreSection } from './page-score.js';
import { resolveBrand } from './brand.js';
import { writeSection } from './doc-layout.js';
import { periodStats, tilesFor, headlineFor, bettermentTable, topSearchesSection } from './doc-model.js';
import { saveWeeklyReportNarrative } from '../store/upsert.js';
import { previousWeek, weekOf } from '../util/dates.js';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => n(v).toLocaleString();
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

// Friendly "Jun 2 – Jun 8, 2026" label.
export function weekLabel(start, end) {
  const opt = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const s = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', opt);
  const e = new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { ...opt, year: 'numeric' });
  return `${s} – ${e}`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (ymd) => DOW[new Date(`${ymd}T00:00:00Z`).getUTCDay()];

// Sum a metric across the daily series.
const sum = (rows, k) => rows.reduce((a, r) => a + n(r[k]), 0);

// Create the doc once and store its id on the site row; reuse it thereafter.
async function ensureDoc(site) {
  if (site.weekly_doc_id) return site.weekly_doc_id;
  const docs = getDocs(site);
  const res = await docs.documents.create({
    requestBody: { title: `${site.name} — Weekly Analytics Report` },
  });
  const id = res.data.documentId;
  await query('UPDATE sites SET weekly_doc_id = $1 WHERE id = $2', [id, site.id]);
  console.log(`[weekly] created report doc ${id}`);
  return id;
}

// Generate (or regenerate) the weekly section and insert it at the TOP of the doc.
// `anchorDate` (YYYY-MM-DD) picks which week; defaults to the previous full week.
export async function runWeeklyDocReport(site, anchorDate) {
  // Resolve the target Mon–Sun week: explicit anchor's week, else the previous full week.
  const { start, end } = anchorDate ? weekOf(anchorDate) : previousWeek(site.timezone);

  const series = await getDailySeries(site.id, start, end);

  // Previous week (for the vs-prior comparison).
  const prevEnd = new Date(`${start}T00:00:00Z`);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevEnd.getUTCDate() - 6);
  const prevSeries = await getDailySeries(
    site.id,
    prevStart.toISOString().slice(0, 10),
    prevEnd.toISOString().slice(0, 10)
  );

  const topQueries = await getRangeTopQueries(site.id, start, end, 5);

  const label = weekLabel(start, end);
  const digest = {
    week: label,
    site: site.name,
    days: series.map((r) => ({
      date: String(r.date).slice(0, 10),
      clicks: n(r.clicks), impressions: n(r.impressions),
      position: r.position == null ? null : Number(r.position),
      users: n(r.users), sessions: n(r.sessions),
    })),
    weekTotals: {
      clicks: sum(series, 'clicks'), impressions: sum(series, 'impressions'),
      users: sum(series, 'users'), sessions: sum(series, 'sessions'),
    },
    prevWeekTotals: {
      clicks: sum(prevSeries, 'clicks'), impressions: sum(prevSeries, 'impressions'),
      users: sum(prevSeries, 'users'), sessions: sum(prevSeries, 'sessions'),
    },
    // Precomputed so the model never has to do its own arithmetic (and risk getting it wrong).
    vsPriorWeekPct: {
      clicks: pct(sum(series, 'clicks'), sum(prevSeries, 'clicks')),
      impressions: pct(sum(series, 'impressions'), sum(prevSeries, 'impressions')),
      users: pct(sum(series, 'users'), sum(prevSeries, 'users')),
      sessions: pct(sum(series, 'sessions'), sum(prevSeries, 'sessions')),
    },
    topQueries: topQueries.map((q) => ({ query: q.dim_value, clicks: n(q.clicks) })),
  };

  const system =
    'You are an analytics assistant writing a short WEEKLY website performance overview for a ' +
    'non-technical business owner. 3–4 sentences. State the week\'s real totals (clicks, impressions, ' +
    'users, sessions), compare to the prior week in plain terms, and name the top query if useful. ' +
    'A lower average Search position is BETTER. This is a low-traffic site, so small/zero numbers are ' +
    'normal — report them plainly without alarm. If you cite a percent change, use ONLY the precomputed ' +
    'vsPriorWeekPct values given — never calculate your own percentage. null means no prior-week baseline; ' +
    'do not invent one. No preamble, no bullet symbols, no markdown headers.';
  // The report is numbers first: if the summary cannot be written (model down, spend limit) it goes out without it.
  let overview = null;
  try { overview = await callLLM(system, `Weekly digest:\n\n${JSON.stringify(digest, null, 2)}`, { maxTokens: 400 }); }
  catch (e) { console.warn('[weekly-doc] summary skipped:', e.message); }

  const brand = resolveBrand(site);
  const cur = periodStats(series);
  const prev = prevSeries.length ? periodStats(prevSeries) : null;
  const baselineRow = await getBaselineReport(site.id);
  const better = bettermentTable({
    baseline: baselineRow?.kpi_snapshot, baselineAt: baselineRow?.generated_at, periodEnd: end,
    cur, prev, currentHealth: await getHealthScoreOnOrBefore(site.id, end), labels: { prev: 'Last week', cur: 'This week' },
  });
  const dayRows = series.map((r) => {
    const date = String(r.date).slice(0, 10);
    return [`${dayName(date)} ${date.slice(8)}`, fmt(r.impressions), fmt(r.clicks), r.position == null ? '—' : Number(r.position).toFixed(1), fmt(r.users)];
  });
  // Per-page score: the same page scored the same way at the first audit and the latest one (null if there is only one).
  const [baselineRun, latestRun] = await Promise.all([getFirstCompletedAuditRun(site.id), getLatestCompletedAuditRun(site.id)]);
  let scoreSection = null;
  if (baselineRun && latestRun && baselineRun.id !== latestRun.id) {
    const [baselineFindings, latestFindings] = await Promise.all([getAuditPageFindings(baselineRun.id, { limit: 5000 }), getAuditPageFindings(latestRun.id, { limit: 5000 })]);
    scoreSection = pageScoreSection({ baselineRun, latestRun, baselineFindings, latestFindings });
  }
  const model = {
    marker: `Week of ${label}`,
    band: { kind: 'Weekly report', period: `Week of ${label}`, sub: brand.website || 'Search and AI visibility' },
    headline: headlineFor(cur, prev, 'this week', 'the prior week'),
    summary: overview,
    tiles: tilesFor(cur, prev, 'prior week'),
    barsTitle: 'Clicks by day',
    bars: series.map((r) => ({ label: dayName(String(r.date).slice(0, 10)), value: n(r.clicks), valueText: fmt(r.clicks) })),
    sections: [
      { title: 'Day by day', table: { head: ['Day', 'Impressions', 'Clicks', 'Position', 'Users'], totalRow: true,
        rows: [...dayRows, ['Week', fmt(cur.impressions), fmt(cur.clicks), cur.position == null ? '—' : cur.position.toFixed(1), fmt(cur.users)]] } },
      better && { title: better.title, sub: better.sub, table: better.table },
      scoreSection,
      topSearchesSection(topQueries),
    ].filter(Boolean),
    footer: `Prepared for ${site.name}${brand.website ? ` (${brand.website})` : ''} · search data final through ${label.split('–')[1].trim()}`,
  };

  const docId = await ensureDoc(site);
  await writeSection(getDocs(site), docId, model, brand);

  if (overview) await saveWeeklyReportNarrative(site.id, start, end, overview);

  console.log(`[weekly] wrote section for ${label} to doc ${docId}`);
  return { docId, start, end, url: `https://docs.google.com/document/d/${docId}/edit` };
}
