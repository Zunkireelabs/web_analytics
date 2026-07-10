import { getDocs } from '../auth/google.js';
import { query } from '../db.js';
import { callLLM } from '../llm.js';
import { getDailySeries } from '../store/read.js';

const n = (v) => (v == null ? 0 : Number(v));
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const fmt = (v) => n(v).toLocaleString();

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function dayLabel(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

async function ensureDoc(site) {
  if (site.daily_doc_id) return site.daily_doc_id;
  const docs = getDocs(site);
  const res = await docs.documents.create({
    requestBody: { title: `${site.name} — Daily Analytics Report` },
  });
  const id = res.data.documentId;
  await query('UPDATE sites SET daily_doc_id = $1 WHERE id = $2', [id, site.id]);
  console.log(`[daily-doc] created doc ${id}`);
  return id;
}

// Insert a single day's section at the top of the daily report doc.
export async function runDailyDocReport(site, date) {
  const [row] = await getDailySeries(site.id, date, date);

  // Previous day for comparison context in the AI prompt.
  const prev = new Date(`${date}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDate = prev.toISOString().slice(0, 10);
  const [prevRow] = await getDailySeries(site.id, prevDate, prevDate);

  const clicks = n(row?.clicks), impressions = n(row?.impressions), users = n(row?.users), sessions = n(row?.sessions);
  const prevClicks = n(prevRow?.clicks), prevImpressions = n(prevRow?.impressions), prevUsers = n(prevRow?.users), prevSessions = n(prevRow?.sessions);

  const digest = {
    date,
    site: site.name,
    clicks, impressions,
    position: row?.position == null ? null : Number(row.position),
    users, sessions,
    prevDay: { clicks: prevClicks, impressions: prevImpressions, users: prevUsers, sessions: prevSessions },
    // Precomputed so the model never has to do its own arithmetic (and risk getting it wrong).
    vsPriorDayPct: {
      clicks: pct(clicks, prevClicks), impressions: pct(impressions, prevImpressions),
      users: pct(users, prevUsers), sessions: pct(sessions, prevSessions),
    },
  };

  const system =
    'You are an analytics assistant writing a 1–2 sentence daily summary for a non-technical ' +
    'business owner. State the day\'s real numbers (clicks, impressions, users, sessions), note ' +
    'anything notable vs the prior day in plain terms. A lower average Search position is BETTER. ' +
    'This is a low-traffic site so small/zero numbers are normal — report them plainly without alarm. ' +
    'If you cite a percent change, use ONLY the precomputed vsPriorDayPct values given — never calculate ' +
    'your own percentage. null means no prior-day baseline; do not invent one. ' +
    'No preamble, no bullet symbols, no markdown headers. Under 80 words.';
  const overview = await callLLM(system, `Daily digest:\n\n${JSON.stringify(digest, null, 2)}`, { maxTokens: 150 });

  const label = dayLabel(date);
  let text = '';
  const add = (s) => { text += s; };

  const headingStart = text.length;
  add(`${label}\n`);
  const heading = { start: headingStart, end: text.length - 1 };

  const summaryStart = text.length;
  add(overview);
  const summary = { start: summaryStart, end: text.length };
  add('\n\n');

  add(
    `Clicks: ${fmt(row?.clicks)} | Impressions: ${fmt(row?.impressions)} | ` +
    `Avg Position: ${row?.position == null ? '—' : Number(row.position).toFixed(1)} | ` +
    `Users: ${fmt(row?.users)} | Sessions: ${fmt(row?.sessions)}\n`
  );
  add('\n');
  add('────────────────────────────────────────\n');
  add('\n');

  const docId = await ensureDoc({ ...site, daily_doc_id: site.daily_doc_id });
  const docs = getDocs(site);
  const base = 1;

  const requests = [{ insertText: { location: { index: base }, text } }];

  // Heading: bold, 13pt, keep-with-next so it doesn't orphan from the summary.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + heading.start, endIndex: base + heading.end },
      textStyle: { bold: true, fontSize: { magnitude: 13, unit: 'PT' } },
      fields: 'bold,fontSize',
    },
  });
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base + heading.start, endIndex: base + heading.end },
      paragraphStyle: { keepWithNext: true },
      fields: 'keepWithNext',
    },
  });

  // Summary: italic, 10pt, grey Georgia.
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

  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  console.log(`[daily-doc] wrote entry for ${date} to doc ${docId}`);
  return { docId, date, url: `https://docs.google.com/document/d/${docId}/edit` };
}
