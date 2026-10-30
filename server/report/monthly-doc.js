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
import { saveMonthlyReportNarrative } from '../store/upsert.js';
import { previousMonth } from '../util/dates.js';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => n(v).toLocaleString();

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function shortDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Split [monthStart, monthEnd] into Mon–Sun calendar weeks, clipped to month bounds.
function monthWeeks(monthStart, monthEnd) {
  const weeks = [];
  const endDate = new Date(`${monthEnd}T00:00:00Z`);
  let cur = new Date(`${monthStart}T00:00:00Z`);

  while (cur <= endDate) {
    const wkStart = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay(); // 0=Sun..6=Sat
    const daysToSun = dow === 0 ? 0 : 7 - dow;
    const sun = new Date(cur);
    sun.setUTCDate(cur.getUTCDate() + daysToSun);
    const wkEnd = sun <= endDate ? sun.toISOString().slice(0, 10) : monthEnd;
    weeks.push({ start: wkStart, end: wkEnd });
    cur = new Date(sun);
    cur.setUTCDate(sun.getUTCDate() + 1);
  }
  return weeks;
}

const sum = (rows, k) => rows.reduce((a, r) => a + n(r[k]), 0);
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

// If the doc's top section is already for this exact month (re-running the same
// month), return its full range so the caller can delete it before re-inserting —
// otherwise re-running would stack a duplicate section instead of regenerating.
function staleTopSection(content, label) {
  // content[0] is often a zero-width sectionBreak, not the first paragraph — skip to it.
  const paras = (content || []).filter((el) => el.paragraph);
  if (!paras.length) return null;
  const first = paras[0];
  const firstText = (first.paragraph.elements || []).map((e) => e.textRun?.content || '').join('').trim();
  if (firstText !== label) return null;
  for (const el of paras) {
    const text = (el.paragraph.elements || []).map((e) => e.textRun?.content || '').join('').trim();
    if (/^─+$/.test(text)) return { start: first.startIndex, end: el.endIndex };
  }
  return null;
}

async function ensureDoc(site) {
  if (site.monthly_doc_id) return site.monthly_doc_id;
  const docs = getDocs(site);
  const res = await docs.documents.create({
    requestBody: { title: `${site.name} — Monthly Analytics Report` },
  });
  const id = res.data.documentId;
  await query('UPDATE sites SET monthly_doc_id = $1 WHERE id = $2', [id, site.id]);
  console.log(`[monthly] created report doc ${id}`);
  return id;
}

// Generate (or regenerate) the monthly section and insert it at the TOP of the doc.
// `anchorYm` (YYYY-MM) picks which month; defaults to the previous complete calendar month.
export async function runMonthlyDocReport(site, anchorYm) {
  let year, month;
  if (anchorYm) {
    [year, month] = anchorYm.split('-').map(Number);
  } else {
    const prev = previousMonth(site.timezone);
    year = prev.year;
    month = prev.month;
  }

  const monthStr = String(month).padStart(2, '0');
  const start = `${year}-${monthStr}-01`;
  // Last day of target month: day 0 of (month+1) = last of month
  const lastDay = new Date(Date.UTC(year, month, 0));
  const end = lastDay.toISOString().slice(0, 10);

  const series = await getDailySeries(site.id, start, end);

  // Previous month for comparison
  const prevM = month === 1 ? 12 : month - 1;
  const prevY = month === 1 ? year - 1 : year;
  const prevMonthStr = String(prevM).padStart(2, '0');
  const prevStart = `${prevY}-${prevMonthStr}-01`;
  const prevLastDay = new Date(Date.UTC(prevY, prevM, 0));
  const prevEnd = prevLastDay.toISOString().slice(0, 10);
  const prevSeries = await getDailySeries(site.id, prevStart, prevEnd);
  const prevTotals = {
    clicks: sum(prevSeries, 'clicks'),
    impressions: sum(prevSeries, 'impressions'),
    users: sum(prevSeries, 'users'),
    sessions: sum(prevSeries, 'sessions'),
  };

  const topQueries = await getRangeTopQueries(site.id, start, end, 10);

  const label = monthLabel(year, month);
  const prevLabel = monthLabel(prevY, prevM);

  const totals = {
    clicks: sum(series, 'clicks'),
    impressions: sum(series, 'impressions'),
    users: sum(series, 'users'),
    sessions: sum(series, 'sessions'),
  };

  const digest = {
    month: label,
    site: site.name,
    totals,
    prevMonth: prevLabel,
    prevTotals,
    // Precomputed so the model never has to do its own arithmetic (and risk getting it wrong).
    vsPriorMonthPct: {
      clicks: pct(totals.clicks, prevTotals.clicks),
      impressions: pct(totals.impressions, prevTotals.impressions),
      users: pct(totals.users, prevTotals.users),
      sessions: pct(totals.sessions, prevTotals.sessions),
    },
    topQueries: topQueries.map((q) => ({ query: q.dim_value, clicks: n(q.clicks) })),
  };

  const system =
    'You are an analytics assistant writing a short MONTHLY website performance overview for a ' +
    'non-technical business owner. 3–4 sentences. State the month\'s real totals (clicks, impressions, ' +
    'users, sessions), compare to the prior month in plain terms, and name the top query or trend if useful. ' +
    'A lower average Search position is BETTER. This is a low-traffic site, so small/zero numbers are ' +
    'normal — report them plainly without alarm. If you cite a percent change, use ONLY the precomputed ' +
    'vsPriorMonthPct values given — never calculate your own percentage. null means no prior-month baseline; ' +
    'do not invent one. No preamble, no bullet symbols, no markdown headers.';
  // The report is numbers first: if the summary cannot be written (model down, spend limit) it goes out without it.
  let overview = null;
  try { overview = await callLLM(system, `Monthly digest:\n\n${JSON.stringify(digest, null, 2)}`, { maxTokens: 400 }); }
  catch (e) { console.warn('[monthly-doc] summary skipped:', e.message); }

  const brand = resolveBrand(site);
  const cur = periodStats(series);
  const prev = prevSeries.length ? periodStats(prevSeries) : null;
  const baselineRow = await getBaselineReport(site.id);
  const better = bettermentTable({
    baseline: baselineRow?.kpi_snapshot, baselineAt: baselineRow?.generated_at, periodEnd: end,
    cur, prev, currentHealth: await getHealthScoreOnOrBefore(site.id, end), labels: { prev: 'Last month', cur: 'This month' },
  });
  const weekStats = monthWeeks(start, end).map((w) => ({
    label: `${shortDate(w.start)} – ${shortDate(w.end)}`,
    s: periodStats(series.filter((r) => { const d = String(r.date).slice(0, 10); return d >= w.start && d <= w.end; })),
  }));
  const pos = (v) => (v == null ? '—' : v.toFixed(1));
  // Per-page score: the same page scored the same way at the first audit and the latest one (null if there is only one).
  const [baselineRun, latestRun] = await Promise.all([getFirstCompletedAuditRun(site.id), getLatestCompletedAuditRun(site.id)]);
  let scoreSection = null;
  if (baselineRun && latestRun && baselineRun.id !== latestRun.id) {
    const [baselineFindings, latestFindings] = await Promise.all([getAuditPageFindings(baselineRun.id, { limit: 5000 }), getAuditPageFindings(latestRun.id, { limit: 5000 })]);
    scoreSection = pageScoreSection({ baselineRun, latestRun, baselineFindings, latestFindings });
  }
  const model = {
    marker: label,
    band: { kind: 'Monthly report', period: label, sub: brand.website || 'Search and AI visibility' },
    headline: headlineFor(cur, prev, 'this month', 'the prior month'),
    summary: overview,
    tiles: tilesFor(cur, prev, 'prior month'),
    barsTitle: 'Clicks, week by week',
    bars: weekStats.map((w) => ({ label: w.label, value: w.s.clicks, valueText: fmt(w.s.clicks) })),
    sections: [
      { title: 'Week by week', table: { head: ['Week', 'Impressions', 'Clicks', 'Position', 'Users'], totalRow: true,
        rows: [...weekStats.map((w) => [w.label, fmt(w.s.impressions), fmt(w.s.clicks), pos(w.s.position), fmt(w.s.users)]),
          ['Month', fmt(cur.impressions), fmt(cur.clicks), pos(cur.position), fmt(cur.users)]] } },
      better && { title: better.title, sub: better.sub, table: better.table },
      scoreSection,
      topSearchesSection(topQueries),
    ].filter(Boolean),
    footer: `Prepared for ${site.name}${brand.website ? ` (${brand.website})` : ''} · ${weekStats.length} weekly periods rolled up`,
  };

  const docId = await ensureDoc(site);
  const docs = getDocs(site);
  const docMeta = await docs.documents.get({ documentId: docId, fields: 'body.content' });
  // Regenerating the same month replaces its section instead of stacking a second one.
  const stale = staleTopSection(docMeta.data.body.content, label);
  await writeSection(docs, docId, model, brand, { stale });

  const ym = `${year}-${String(month).padStart(2, '0')}`;
  if (overview) await saveMonthlyReportNarrative(site.id, ym, overview);

  console.log(`[monthly] wrote section for ${label} to doc ${docId}`);
  return { docId, start, end, year, month, url: `https://docs.google.com/document/d/${docId}/edit` };
}
