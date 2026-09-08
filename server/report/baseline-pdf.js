import { marked } from 'marked';
import { chromium } from 'playwright';

// Turns a stored baseline_reports.narrative_md into a downloadable PDF, so
// staff can hand a client a real document instead of a link into the
// dashboard. Reuses the same headless-Chromium launch pattern as the Design
// Agent's live-site capture (server/design-agent/live-analysis/capture.js) —
// Playwright is already a dependency for that, so this needs no new browser
// automation stack, just `marked` for markdown -> HTML.
export function renderBaselineReportHtml(report, site) {
  const body = marked.parse(report.narrative_md || '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${site.name} — Baseline Report</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 720px; margin: 40px auto; line-height: 1.55; }
  h1 { font-size: 22px; font-weight: 900; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 28px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
  p, li { font-size: 13px; color: #334155; }
  ul { padding-left: 20px; }
  strong { color: #0f172a; }
  .meta { font-size: 11px; color: #94a3b8; margin-bottom: 24px; }
</style>
</head>
<body>
  <div class="meta">Generated ${new Date(report.generated_at).toISOString().slice(0, 10)}</div>
  ${body}
</body>
</html>`;
}

export async function renderBaselineReportPdf(html) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({ format: 'Letter', margin: { top: '20px', bottom: '20px' } });
  } finally {
    await browser.close();
  }
}
