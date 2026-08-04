import { getSiteById, getSearchPerformanceRange, getQueriesForPage } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from '../agents/lib/page-content.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { buildGeoAuditReport } from '../agents/lib/geo-audit-report.js';

export const meta = {
  id: 'geo-audit',
  name: 'GEO Audit Generator',
  description: 'Produces a comprehensive GEO audit report for a site — AI visibility score, per-page findings, and prioritized fix list mapped to generators.',
  recommendationTags: ['GEO audit', 'AI visibility', 'structured data', 'llms.txt'],
};

const DEFAULT_WINDOW_DAYS = 90;
const MAX_PAGES = 20;
const PAGE_POOL_SIZE = 200;

// Pages/queries to skip in the audit. Matches case-insensitively against the
// page URL and its top query (e.g. pages that rank mainly for an unrelated
// legal topic like "supreme court" get excluded so their boilerplate GEO
// findings don't clutter the report).
const EXCLUDED_TERMS = ['supreme court'];

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// Fetches everything a report needs (page performance, page HTML analysis,
// llms.txt/robots.txt readiness) and hands it to the pure report builder
// (agents/lib/geo-audit-report.js) — that split is what makes the report
// logic testable without a live DB/network (see geo-audit.test.js).
export async function generate({ siteId, params }) {
  const { start, end } = params.start && params.end ? params : defaultRange();
  const site = await getSiteById(siteId);
  const siteName = site?.name || 'This site';
  const domain = knownDomain(site);

  const pagePerfRaw = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_POOL_SIZE);
  const pagePerf = filterOwnDomainPages(pagePerfRaw, domain)
    .filter((p) => Number(p.impressions) >= 5)
    .filter((p) => !EXCLUDED_TERMS.some((t) => p.dim_value.toLowerCase().includes(t)))
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, MAX_PAGES);

  const urls = pagePerf.map((p) => p.dim_value);

  const fetched = await Promise.all(
    urls.map(async (url) => {
      const result = await analyzePageUrl(url);
      const queries = await getQueriesForPage(siteId, start, end, url, 1);
      const topQuery = queries[0]?.query || '';
      const perf = pagePerf.find((p) => p.dim_value === url);
      return { page: url, result, topQuery, impressions: Number(perf?.impressions || 0) };
    })
  );

  const filtered = fetched.filter(
    (f) => !EXCLUDED_TERMS.some((t) => f.topQuery.toLowerCase().includes(t))
  );

  const llmsReadiness = await checkLlmsReadiness(domain);

  return buildGeoAuditReport({ siteName, start, end, fetched: filtered, llmsReadiness });
}
