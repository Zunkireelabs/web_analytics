import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { pool } from '../db.js';
import { buildProgressReportData } from '../report/progress-data.js';
import { renderProgressReportHtml } from '../report/progress-pdf.js';
import { renderBaselineReportPdf } from '../report/baseline-pdf.js';

// Builds one client's standard monthly progress report PDF from the same code
// the dashboard export uses (report/progress-data.js + progress-pdf.js).
// READ-ONLY: it only SELECTs and fetches the client's own public website.
//
//   node server/scripts/progress-report-pdf.js --site 8864 --out chayce.pdf
//   --manual items.json   extra work the app cannot see (a developer's own pull
//                         request, a removal submitted to Google), an array of
//                         { group: 'Foundation|Content|Trust', status:
//                         'live|waiting|google|prog|planned', title, did, why, next }
//   --html                also write the HTML next to the PDF

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const siteId = Number(arg('site'));
const out = arg('out') || `monthly-progress-report-${siteId}.pdf`;
if (!siteId) { console.error('usage: --site <id> [--out file.pdf] [--manual items.json] [--html]'); process.exit(1); }

try {
  const manualItems = arg('manual') ? JSON.parse(readFileSync(arg('manual'), 'utf8')) : [];
  const data = await buildProgressReportData(siteId, { manualItems });
  const html = renderProgressReportHtml(data);
  if (process.argv.includes('--html')) writeFileSync(out.replace(/\.pdf$/, '.html'), html);
  writeFileSync(out, await renderBaselineReportPdf(html));
  console.log(JSON.stringify({ out, site: data.siteName, accent: data.theme.accent, fellBackToZunkireeGreen: data.theme.fellBack, google: data.google, pages: data.pages, ai: data.ai, workItems: data.work.length, listings: data.listings.length }, null, 2));
} catch (e) {
  console.error(e); process.exitCode = 1;
} finally { await pool.end(); }
