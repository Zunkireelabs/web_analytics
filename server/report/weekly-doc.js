import { getDocs } from '../auth/google.js';
import { query } from '../db.js';
import { callLLM } from '../llm.js';
import { getDailySeries, getRangeTopQueries } from '../store/read.js';
import { saveWeeklyReportNarrative } from '../store/upsert.js';
import { previousWeek, weekOf } from '../util/dates.js';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => n(v).toLocaleString();
const pad = (s, w) => String(s).padEnd(w);
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

// Build the plain-text block for one week (heading + AI overview + day table).
// Returns the text plus character ranges to style: the summary paragraph and each
// weekday name (offsets are 0-based within `text`; callers shift by the insert index).
function buildSection(label, overview, series, prevSeries) {
  let text = '';
  const bold = [];       // weekday name ranges  { start, end }
  const add = (s) => { text += s; };

  // "Week of …" heading — bold + 14pt, sits directly above the summary.
  const weekHeadingStart = text.length;
  add(`Week of ${label}\n`);
  const weekHeading = { start: weekHeadingStart, end: text.length - 1 };

  // AI overview — immediately below the heading (no separating lines).
  const summaryStart = text.length;
  add(overview);
  const summary = { start: summaryStart, end: text.length };
  add('\n\n');

  // Subtitle moved after the summary so heading + summary are flush together.
  add(`Search data final through ${label.split('–')[1].trim()}\n`);
  add('\n');

  // Week totals + vs previous week.
  const tot = (rows) => ({
    clicks: sum(rows, 'clicks'),
    impressions: sum(rows, 'impressions'),
    users: sum(rows, 'users'),
    sessions: sum(rows, 'sessions'),
  });
  const t = tot(series);
  const p = tot(prevSeries);
  const delta = (a, b) => (b === 0 ? '—' : `${a - b >= 0 ? '+' : ''}${Math.round(((a - b) / b) * 100)}%`);
  add(
    `Totals: ${t.clicks} clicks (${delta(t.clicks, p.clicks)}), ${t.impressions} impressions ` +
    `(${delta(t.impressions, p.impressions)}), ${t.users} users, ${t.sessions} sessions  — vs prior week\n`
  );
  add('\n');

  // Column header row — tracked for bold.
  const tableHeaderStart = text.length;
  add(['Day', 'Date', 'Clicks', 'Impr.', 'Position', 'Users', 'Sessions'].join('\t') + '\n');
  const tableHeader = { start: tableHeaderStart, end: text.length - 1 };

  // Per-day rows — each tracked so we can add paragraph spacing.
  const tableRows = [];
  for (const r of series) {
    const date = String(r.date).slice(0, 10);
    const dn = dayName(date);
    const rowStart = text.length;
    const dStart = text.length;
    add(dn);
    bold.push({ start: dStart, end: text.length });   // weekday name only
    add('\t' + [
      date,
      fmt(r.clicks),
      fmt(r.impressions),
      r.position == null ? '—' : Number(r.position).toFixed(1),
      fmt(r.users),
      fmt(r.sessions),
    ].join('\t') + '\n');
    tableRows.push({ start: rowStart, end: text.length - 1 });
  }
  add('\n');
  add('────────────────────────────────────────\n');
  add('\n');

  return { text, bold, summary, weekHeading, tableHeader, tableRows };
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
  const overview = await callLLM(system, `Weekly digest:\n\n${JSON.stringify(digest, null, 2)}`, { maxTokens: 400 });

  const { text: sectionText, bold, summary, weekHeading, tableHeader, tableRows } =
    buildSection(label, overview, series, prevSeries);

  const docId = await ensureDoc(site);
  const docs = getDocs(site);
  // Insert at index 1 (top of body) so the newest week is first.
  const base = 1;
  const requests = [{ insertText: { location: { index: base }, text: sectionText } }];

  // Justify every paragraph in this section.
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base, endIndex: base + sectionText.length },
      paragraphStyle: { alignment: 'JUSTIFIED' },
      fields: 'alignment',
    },
  });

  // "Week of …" heading — bold + 14pt, glued to the next paragraph (summary).
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + weekHeading.start, endIndex: base + weekHeading.end },
      textStyle: { bold: true, fontSize: { magnitude: 14, unit: 'PT' } },
      fields: 'bold,fontSize',
    },
  });
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base + weekHeading.start, endIndex: base + weekHeading.end },
      paragraphStyle: { keepWithNext: true },
      fields: 'keepWithNext',
    },
  });

  // Summary paragraph — italic, smaller, grey Georgia serif.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + summary.start, endIndex: base + summary.end },
      textStyle: {
        italic: true,
        fontSize: { magnitude: 10, unit: 'PT' },
        weightedFontFamily: { fontFamily: 'Georgia' },
        foregroundColor: { color: { rgbColor: { red: 0.32, green: 0.33, blue: 0.36 } } },
      },
      fields: 'italic,fontSize,weightedFontFamily,foregroundColor',
    },
  });

  // Column header row — bold.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + tableHeader.start, endIndex: base + tableHeader.end },
      textStyle: { bold: true },
      fields: 'bold',
    },
  });

  // Bold each weekday name in the day table.
  for (const b of bold) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: base + b.start, endIndex: base + b.end },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }

  // Add breathing room above each data row so the table isn't congested.
  for (const row of tableRows) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + row.start, endIndex: base + row.end },
        paragraphStyle: { spaceAbove: { magnitude: 4, unit: 'PT' } },
        fields: 'spaceAbove',
      },
    });
  }

  // Requests apply in order, so styling references the just-inserted text's indices.
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  await saveWeeklyReportNarrative(site.id, start, end, overview);

  console.log(`[weekly] wrote section for ${label} to doc ${docId}`);
  return { docId, start, end, url: `https://docs.google.com/document/d/${docId}/edit` };
}
