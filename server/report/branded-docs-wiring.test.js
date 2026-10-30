import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// brand.test.js / doc-layout.test.js / doc-model.test.js cover the pieces. This covers what can break without them
// noticing: that the weekly and monthly generators really hand their numbers to the branded builder, with THIS
// client's colour, and that the monthly re-run still replaces its own section instead of stacking another.

let docCalls;       // every batchUpdate: { documentId, requests }
let docContent;     // what documents.get returns
let queries;        // SQL the generators ran (ensureDoc stores the new doc id)

const fakeDocs = {
  documents: {
    create: async () => ({ data: { documentId: 'doc-new' } }),
    get: async () => ({ data: { body: { content: docContent() } } }),
    batchUpdate: async ({ documentId, requestBody }) => { docCalls.push({ documentId, requests: requestBody.requests }); },
  },
};

const days = (start, n, clicks) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), clicks, impressions: clicks * 10, position: 8.5, users: clicks / 2, sessions: clicks / 2 };
});

mock.module('../auth/google.js', { namedExports: { getDocs: () => fakeDocs } });
mock.module('../db.js', { namedExports: { query: async (sql) => { queries.push(sql); return { rows: [] }; } } });
mock.module('../llm.js', { namedExports: { callLLM: async () => 'A short plain summary.' } });
mock.module('../store/read.js', { namedExports: {
  getDailySeries: async (_id, start) => (start.startsWith('2026-10') ? days(start, 31, 20) : days(start, 7, 18)),
  getRangeTopQueries: async () => [{ dim_value: 'seo report', clicks: 12 }],
  getHealthScoreOnOrBefore: async () => 86,
} });
mock.module('../store/baseline-reports.js', { namedExports: { getBaselineReport: async () => ({ generated_at: '2026-09-01T00:00:00Z', kpi_snapshot: { daysOfHistory: 30, clicks: 300, impressions: 3000, healthScore: 71 } }) } });
mock.module('../store/audit-runs.js', { namedExports: {
  getFirstCompletedAuditRun: async () => ({ id: 1 }), getLatestCompletedAuditRun: async () => ({ id: 2 }),
  getAuditPageFindings: async (id) => (id === 1 ? [{ page: 'https://x.com/a', priority: 'high' }, { page: 'https://x.com/a', priority: 'high' }] : [{ page: 'https://x.com/a', priority: 'high' }]),
} });
mock.module('../store/upsert.js', { namedExports: { saveWeeklyReportNarrative: async () => {}, saveMonthlyReportNarrative: async () => {} } });

const { runWeeklyDocReport } = await import('./weekly-doc.js');
const { runMonthlyDocReport } = await import('./monthly-doc.js');

const navy = (r) => r.updateTableCellStyle && Math.abs(r.updateTableCellStyle.tableCellStyle.backgroundColor.color.rgbColor.blue - 0x82 / 255) < 0.01;

// A document shaped the way Docs returns the structure pass: a stray empty paragraph before each table.
function contentFor(requests) {
  const ins = requests.filter((r) => r.insertText || r.insertTable).reverse(); // the order they land in the doc
  let idx = 1; const out = [];
  const para = (t) => { const s = idx; idx += t.length + 1; out.push({ startIndex: s, endIndex: idx, paragraph: { elements: [{ textRun: { content: `${t}\n` } }] } }); };
  for (const r of ins) {
    if (r.insertText) { para(r.insertText.text.replace(/\n$/, '')); continue; }
    para('');
    const start = idx; idx += 1; const tableRows = [];
    for (let i = 0; i < r.insertTable.rows; i += 1) { idx += 1; const tableCells = []; for (let c = 0; c < r.insertTable.columns; c += 1) { idx += 1; tableCells.push({ content: [{ startIndex: idx }] }); idx += 1; } tableRows.push({ tableCells }); }
    out.push({ startIndex: start, endIndex: idx, table: { tableRows } });
  }
  return out;
}

beforeEach(() => {
  docCalls = []; queries = [];
  docContent = () => (docCalls.length ? contentFor(docCalls[0].requests.filter((r) => !r.deleteContentRange)) : [{ endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }]);
});

const SITE = { id: 7, name: 'Admizz Education', website_domain: 'https://admizz.example/', timezone: 'Asia/Kathmandu', url_file_map: { siteRoot: { designProfile: { color: { accent: '#0d1282' } } } }, weekly_doc_id: 'doc-w', monthly_doc_id: 'doc-m' };

test('weekly: writes the branded section with this client\'s colour, in two passes', async () => {
  const r = await runWeeklyDocReport(SITE, '2026-10-21');
  assert.equal(r.docId, 'doc-w');
  assert.equal(docCalls.length, 2);
  const text = docCalls[0].requests.filter((q) => q.insertText).map((q) => q.insertText.text).join('|');
  assert.match(text, /Weekly report|Week of/);
  assert.match(text, /Prepared for Admizz Education/);
  assert.match(text, /Page scores that improved/);
  const filled = docCalls[1].requests.filter((q) => q.insertText).map((q) => q.insertText.text).join('|');
  assert.match(filled, /Admizz Education\nadmizz\.example/, 'the band shows the project name with its own website under it');
  const cells = filled.split('|'); // cells are written last-first, so check membership, not order
  assert.ok(['/a', '76', '88'].every((c) => cells.includes(c)), 'the improved page and its before/after score are in the table cells');
  assert.ok(docCalls[1].requests.some(navy), 'the client\'s own navy fills the band');
  // The tiles and tables are real Docs tables, not tab-separated text.
  assert.ok(docCalls[0].requests.filter((q) => q.insertTable).length >= 4);
});

test('weekly: a client with no usable colour gets the Zunkiree green, not another client\'s colour', async () => {
  await runWeeklyDocReport({ ...SITE, url_file_map: null }, '2026-10-21');
  assert.ok(!docCalls[1].requests.some(navy));
});

test('monthly: writes the branded section and replaces a re-run of the same month', async () => {
  await runMonthlyDocReport(SITE, '2026-10');
  assert.equal(docCalls.length, 2);
  assert.ok(!docCalls[0].requests[0].deleteContentRange, 'first run has nothing to replace');
  assert.ok(docCalls[1].requests.some(navy));

  // Re-run: the doc's top section is already October 2026, ending in its rule line.
  docCalls = [];
  const rule = '─'.repeat(38);
  docContent = () => (docCalls.length
    ? contentFor(docCalls[0].requests.filter((r) => !r.deleteContentRange))
    : [
      { startIndex: 1, endIndex: 16, paragraph: { elements: [{ textRun: { content: 'October 2026\n' } }] } },
      { startIndex: 16, endIndex: 60, paragraph: { elements: [{ textRun: { content: `${rule}\n` } }] } },
    ]);
  await runMonthlyDocReport(SITE, '2026-10');
  assert.deepEqual(docCalls[0].requests[0].deleteContentRange.range, { startIndex: 1, endIndex: 60 });
});
