import 'dotenv/config';
import { pool, getOrCreateSite } from '../db.js';
import { getDocs } from '../auth/google.js';

// One-off: retro-apply the weekly-report styling to ALL existing sections in the
// doc — bold weekday names in day tables, and the "summary" look on each AI overview.
// updateTextStyle never shifts indices, so we read once and style off those indices.

const DOW = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const SUMMARY_STYLE = {
  italic: true,
  fontSize: { magnitude: 10, unit: 'PT' },
  weightedFontFamily: { fontFamily: 'Georgia' },
  foregroundColor: { color: { rgbColor: { red: 0.32, green: 0.33, blue: 0.36 } } },
};
const SUMMARY_FIELDS = 'italic,fontSize,weightedFontFamily,foregroundColor';

async function main() {
  const site = await getOrCreateSite();
  const docId = site.weekly_doc_id;
  if (!docId) throw new Error('site has no weekly_doc_id');

  const docs = getDocs();
  const { data } = await docs.documents.get({ documentId: docId });
  const paras = (data.body.content || []).filter((e) => e.paragraph);

  const requests = [];
  // Track the last few paragraph indices so we can chain keepWithNext on the
  // heading → subtitle → blank line, keeping them glued to the summary that follows.
  let lastHeadingIdx = null;   // index of the most recent "Week of …" paragraph
  let expectSummary = false;
  let bold = 0, summaries = 0, headings = 0, headers = 0, rows = 0;

  for (const el of paras) {
    const text = (el.paragraph.elements || []).map((r) => r.textRun?.content ?? '').join('');
    const trimmed = text.trim();

    // "Week of …" heading — bold + 14pt + keepWithNext (starts the chain).
    if (trimmed.startsWith('Week of ')) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          textStyle: { bold: true, fontSize: { magnitude: 14, unit: 'PT' } },
          fields: 'bold,fontSize',
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          paragraphStyle: { keepWithNext: true },
          fields: 'keepWithNext',
        },
      });
      lastHeadingIdx = el.startIndex;
      headings++;
    }

    // "Search data final through…" subtitle and any blank lines immediately following
    // the heading — chain keepWithNext so the whole block stays above the summary.
    if (
      lastHeadingIdx !== null &&
      (trimmed.startsWith('Search data final through') || trimmed === '')
    ) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: el.startIndex, endIndex: Math.max(el.startIndex + 1, el.endIndex - 1) },
          paragraphStyle: { keepWithNext: true },
          fields: 'keepWithNext',
        },
      });
      // Once we hit the summary (non-blank, non-subtitle line) we stop the chain.
    } else if (lastHeadingIdx !== null && trimmed.length > 0 && !trimmed.startsWith('Week of ')) {
      lastHeadingIdx = null; // summary reached — chain done
    }

    // Column header row — bold the whole line.
    if (trimmed.startsWith('Day\tDate\t')) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
      headers++;
    }

    // Bold the weekday name (first 3 chars) and add row spacing on day-table rows.
    const dow = text.slice(0, 3);
    if (DOW.has(dow) && text[3] === '\t') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: el.startIndex, endIndex: el.startIndex + 3 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          paragraphStyle: { spaceAbove: { magnitude: 4, unit: 'PT' } },
          fields: 'spaceAbove',
        },
      });
      bold++;
      rows++;
    }

    // Section flow: arm on "final through", style overview paragraphs until "Totals:".
    if (trimmed.startsWith('Search data final through')) {
      expectSummary = true;
    } else if (expectSummary) {
      if (trimmed.startsWith('Totals:')) {
        expectSummary = false;
      } else if (trimmed.length > 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
            textStyle: SUMMARY_STYLE,
            fields: SUMMARY_FIELDS,
          },
        });
        summaries++;
      }
    }
  }

  // Justify every paragraph in the doc (one range over the whole body).
  const docEnd = paras[paras.length - 1]?.endIndex;
  if (docEnd > 2) {
    requests.unshift({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: docEnd - 1 },
        paragraphStyle: { alignment: 'JUSTIFIED' },
        fields: 'alignment',
      },
    });
  }

  if (requests.length === 0) {
    console.log('Nothing to restyle.');
    return;
  }

  // Chunk to stay well under API request limits.
  for (let i = 0; i < requests.length; i += 200) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: requests.slice(i, i + 200) },
    });
  }

  console.log(
    `Restyled doc ${docId}: ${headings} headings (bold 14pt), ${headers} table headers bolded, ` +
    `${bold} weekday names bolded, ${rows} rows spaced, ${summaries} summaries styled.`
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Restyle failed:', err.message);
    await pool.end();
    process.exit(1);
  });
