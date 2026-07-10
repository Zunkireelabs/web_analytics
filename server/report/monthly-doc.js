import { getDocs } from '../auth/google.js';
import { query } from '../db.js';
import { callLLM } from '../llm.js';
import { getDailySeries, getRangeTopQueries } from '../store/read.js';
import { previousMonth } from '../util/dates.js';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => n(v).toLocaleString();
const pL = (s, w) => String(s).padEnd(w);
const pR = (s, w) => String(s).padStart(w);

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
const wavg = (rows, k) => {
  const vals = rows.filter((r) => r[k] != null).map((r) => Number(r[k]));
  return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
};

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

function buildSection(label, overview, series, monthStart, monthEnd, prevLabel, prevTotals) {
  let text = '';
  const bold = [];
  const add = (s) => { text += s; };

  // Heading
  const headingStart = text.length;
  add(`${label}\n`);
  const heading = { start: headingStart, end: text.length - 1 };

  // AI summary
  const summaryStart = text.length;
  add(overview);
  const summary = { start: summaryStart, end: text.length };
  add('\n\n');

  // Monthly totals vs prior month
  const t = {
    clicks: sum(series, 'clicks'),
    impressions: sum(series, 'impressions'),
    users: sum(series, 'users'),
    sessions: sum(series, 'sessions'),
  };
  const p = prevTotals;
  const delta = (a, b) => (b === 0 ? '—' : `${a - b >= 0 ? '+' : ''}${Math.round(((a - b) / b) * 100)}%`);
  const totalsStart = text.length;
  add(
    `Totals: ${fmt(t.clicks)} clicks (${delta(t.clicks, p.clicks)}), ` +
    `${fmt(t.impressions)} impressions (${delta(t.impressions, p.impressions)}), ` +
    `${fmt(t.users)} users, ${fmt(t.sessions)} sessions — vs ${prevLabel}\n`
  );
  const totalsLine = { start: totalsStart, end: text.length - 1 };
  add('\n');

  // Week-by-week table — fixed-width columns (Courier New applied by caller).
  // Week col = "May 01 – May 31" = 15 chars, col width 17 to give 2 spaces gap.
  const WK_COL = 17;
  const weeks = monthWeeks(monthStart, monthEnd);

  const tableHeaderStart = text.length;
  add(pL('Week', WK_COL) + pR('Clicks', 8) + pR('Impr.', 8) + pR('Pos.', 8) + pR('Users', 8) + pR('Sess.', 8) + '\n');
  const tableHeader = { start: tableHeaderStart, end: text.length - 1 };

  const tableRows = [];
  for (const wk of weeks) {
    const wkRows = series.filter((r) => {
      const d = String(r.date).slice(0, 10);
      return d >= wk.start && d <= wk.end;
    });
    const wkLabel = `${shortDate(wk.start)} – ${shortDate(wk.end)}`; // "May 01 – May 07"
    const rowStart = text.length;
    const lblStart = text.length;
    add(wkLabel);
    bold.push({ start: lblStart, end: text.length });
    const pos = wavg(wkRows, 'position');
    add(pL('', WK_COL - wkLabel.length) +
      pR(fmt(sum(wkRows, 'clicks')), 8) +
      pR(fmt(sum(wkRows, 'impressions')), 8) +
      pR(pos == null ? '—' : pos.toFixed(1), 8) +
      pR(fmt(sum(wkRows, 'users')), 8) +
      pR(fmt(sum(wkRows, 'sessions')), 8) + '\n');
    tableRows.push({ start: rowStart, end: text.length - 1 });
  }

  const tableSection = {
    start: tableHeaderStart,
    end: tableRows.length ? tableRows[tableRows.length - 1].end : tableHeader.end,
  };

  add('────────────────────────────────────────────────────────────────────────────────\n');

  return { text, bold, summary, heading, tableHeader, tableRows, tableSection, totalsLine };
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
  const overview = await callLLM(system, `Monthly digest:\n\n${JSON.stringify(digest, null, 2)}`, { maxTokens: 400 });

  const { text: sectionText, bold, summary, heading, tableHeader, tableRows, tableSection, totalsLine } =
    buildSection(label, overview, series, start, end, prevLabel, prevTotals);

  const docId = await ensureDoc(site);
  const docs = getDocs(site);
  const base = 1;

  const docMeta = await docs.documents.get({ documentId: docId, fields: 'body.content' });
  const content = docMeta.data.body.content;
  const docWasEmpty = (content.at(-1)?.endIndex ?? 2) <= 2;

  const requests = [];
  const stale = staleTopSection(content, label);
  if (stale) {
    // Regenerating the same month: drop the old section first instead of duplicating it.
    requests.push({ deleteContentRange: { range: { startIndex: stale.start, endIndex: stale.end } } });
  }
  requests.push({ insertText: { location: { index: base }, text: sectionText } });

  // Left-align the whole section (monospace tables don't justify well).
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base, endIndex: base + sectionText.length },
      paragraphStyle: { alignment: 'START' },
      fields: 'alignment',
    },
  });

  // Base font for the whole section: Courier New 12pt bold (heading + summary override below).
  requests.push({
    updateTextStyle: {
      range: { startIndex: base, endIndex: base + sectionText.length },
      textStyle: { weightedFontFamily: { fontFamily: 'Courier New' }, fontSize: { magnitude: 12, unit: 'PT' }, bold: false },
      fields: 'weightedFontFamily,fontSize,bold',
    },
  });

  // Heading: 16pt bold, keep with next.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + heading.start, endIndex: base + heading.end },
      textStyle: { bold: true, fontSize: { magnitude: 16, unit: 'PT' } },
      fields: 'bold,fontSize',
    },
  });

  // Keep the entire month block (heading → last week row) on the same page.
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base + heading.start, endIndex: base + tableSection.end - 1 },
      paragraphStyle: { keepWithNext: true },
      fields: 'keepWithNext',
    },
  });

  // Summary: italic 14pt grey Georgia (not bold).
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + summary.start, endIndex: base + summary.end },
      textStyle: {
        italic: true,
        bold: false,
        fontSize: { magnitude: 14, unit: 'PT' },
        weightedFontFamily: { fontFamily: 'Georgia' },
        foregroundColor: { color: { rgbColor: { red: 0.32, green: 0.33, blue: 0.36 } } },
      },
      fields: 'italic,bold,fontSize,weightedFontFamily,foregroundColor',
    },
  });

  // Totals line: bold.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + totalsLine.start, endIndex: base + totalsLine.end },
      textStyle: { bold: true },
      fields: 'bold',
    },
  });

  // Table header: bold.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + tableHeader.start, endIndex: base + tableHeader.end },
      textStyle: { bold: true },
      fields: 'bold',
    },
  });

  // Bold each week label.
  for (const b of bold) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: base + b.start, endIndex: base + b.end },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }

  // Generous spacing above each week row.
  for (const row of tableRows) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + row.start, endIndex: base + row.end },
        paragraphStyle: { spaceAbove: { magnitude: 8, unit: 'PT' } },
        fields: 'spaceAbove',
      },
    });
  }

  if (docWasEmpty) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + sectionText.length, endIndex: base + sectionText.length + 1 },
        paragraphStyle: { alignment: 'START' },
        fields: 'alignment',
      },
    });
    requests.push({
      deleteContentRange: {
        range: { startIndex: base + sectionText.length - 1, endIndex: base + sectionText.length },
      },
    });
  }

  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  console.log(`[monthly] wrote section for ${label} to doc ${docId}`);
  return { docId, start, end, year, month, url: `https://docs.google.com/document/d/${docId}/edit` };
}
