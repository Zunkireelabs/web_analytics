import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { pickPages, runDrift, MAX_PAGES } from './lib/seo-drift-runner.js';
import { normalizePageUrl } from '../lib/seo-snapshot.js';

export const meta = {
  id: 'seo-drift',
  name: 'SEO Drift Monitor',
  description: 'Watches the site\'s key pages for silent SEO regressions: a title or canonical changed, noindex added, structured data removed, a page that now errors. Catches it the day it happens, whoever caused it.',
  category: 'technical',
  requiresCapabilities: ['public-web'],
  version: 1,
};

// Method and rule set follow claude-seo's seo-drift skill (MIT, (c) 2026 agricidaniel; skill by Dan Colta); see
// agents/lib/seo-drift-rules.js for what is and is not ported.
// Rollout controls, read on every run so they work without a deploy:
//   SEO_DRIFT_DISABLED=true      the monitor does nothing (no page is fetched, nothing is stored, nothing is reported)
//   SEO_DRIFT_MAX_PAGES=<n>      pages watched per project per night, default 25, never more than 100
export const driftEnabled = (env = process.env) => !/^(1|true|on|yes)$/i.test(String(env.SEO_DRIFT_DISABLED || '').trim());
export const driftMaxPages = (env = process.env) => Math.min(100, Math.max(1, Number.parseInt(env.SEO_DRIFT_MAX_PAGES, 10) || MAX_PAGES));

export async function run({ siteId, start, end, params, dryRun = false }) {
  if (!driftEnabled()) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'The SEO drift monitor is switched off (SEO_DRIFT_DISABLED).', generatedAt: new Date().toISOString() };
  }
  const max = driftMaxPages();
  const site = await getSiteById(siteId);
  const top = params?.pages?.length ? [] : await getSearchPerformanceRange(siteId, start, end, 'page', max).catch(() => []);
  // A re-check of one page (params.pages) looks at exactly that page; the home page is only added to the nightly sweep.
  const pages = pickPages({ site: params?.pages?.length ? null : site, topPages: params?.pages?.length ? params.pages : top.map((r) => r.dim_value), max });

  if (!pages.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No pages to watch yet: no website address on the project and no search data to pick pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const impressionsByPage = new Map();
  for (const r of top) { try { impressionsByPage.set(normalizePageUrl(r.dim_value), Number(r.impressions) || 0); } catch { /* not a URL */ } }

  // A dry run looks and reports but writes nothing: no snapshot is stored and no baseline moves.
  const r = await runDrift({ siteId, pages, impressionsByPage, deps: dryRun ? { insertSnapshot: async () => {}, pruneSnapshots: async () => {} } : {} });
  const facts = {
    rangeStart: start, rangeEnd: end,
    // Every page captured this run. A finding that is no longer raised for a page in this list is a regression that has been put
    // right, so the recommendation closes by itself; a page NOT in the list (unreachable tonight) keeps its recommendation open.
    checkedPages: r.checkedPages,
    pagesChecked: r.pagesChecked, firstCaptures: r.firstCaptures, unverifiable: r.unverifiable, suppressedOwnChanges: r.suppressedOwnChanges,
    changesSeen: r.history,
    findings: r.findings,
  };
  return {
    meta, status: 'ok', facts,
    narrative: r.findings.length ? `${r.findings.length} page${r.findings.length === 1 ? ' has' : 's have'} changed in a way that can affect search since they were last known to be fine.` : null,
    generatedAt: new Date().toISOString(),
  };
}
