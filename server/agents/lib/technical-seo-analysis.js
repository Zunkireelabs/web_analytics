import { analyzePageUrl, isPrivateOrLocalHost } from './page-content.js';
import { inspectUrl } from '../../ingest/gsc-technical.js';
import { fetchCoreWebVitals, configured as pagespeedConfigured } from '../../ingest/pagespeed.js';
import { listTitlesForSite } from '../../store/technical-seo-checks.js';

// Rotation-batch selection now lives in agents/lib/candidate-pages.js
// (selectCandidatePages, called from technical-seo.js with an adapter over
// this file's own technical_seo_checks table) — it merges real GSC top
// pages with the site-wide page inventory (sitemap + crawl), which this
// file's original candidate list (GSC pages only) never saw.

const MAX_LINK_CHECKS_PER_DAY = 100;
const MAX_REDIRECT_HOPS = 8;
const REDIRECT_HOP_TIMEOUT_MS = 5000;
const LONG_CHAIN_HOP_THRESHOLD = 3;
const UA_HEADER = { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +technical-seo-agent)' };

// Per page: real page fetch/analysis (reused for the technical audit AND
// the link crawl below — one fetch, not two), real GSC index status, and
// (if PAGESPEED_API_KEY is configured) real Core Web Vitals. Each of the
// three is independently optional — one failing doesn't block the others,
// same "four independent honest {ok,error} results" shape the persistence
// table (migration 026) is built around.
export async function runPageChecks(site, pages, pageCache) {
  // Falls back to a direct (uncached) fetch when run standalone, outside an
  // orchestrated run — keeps this agent independently runnable/testable
  // with identical output either way (see lib/fetch-cache.js).
  const fetchPage = pageCache || analyzePageUrl;
  return Promise.all(pages.map(async (page) => {
    const [pageAnalysis, indexStatus, coreWebVitals] = await Promise.all([
      fetchPage(page),
      inspectUrl(site, page),
      pagespeedConfigured()
        ? fetchCoreWebVitals(page).catch((err) => ({ ok: false, error: String(err?.message || err) }))
        : Promise.resolve({ ok: false, error: 'not-configured' }),
    ]);
    return {
      page,
      analysis: pageAnalysis.ok ? pageAnalysis.analysis : null,
      technicalAudit: pageAnalysis.ok
        ? { ok: true, hasCanonical: pageAnalysis.analysis.hasCanonical, hasSchema: pageAnalysis.analysis.hasSchema, schemaTypes: pageAnalysis.analysis.schemaTypes, title: pageAnalysis.analysis.title }
        : { ok: false, error: pageAnalysis.error },
      indexStatus,
      coreWebVitals,
    };
  }));
}

// Site-wide duplicate-title detection — checked against every page this
// site has EVER had checked (technical_seo_checks), not just today's
// rotation batch. This is the one check type that can be genuinely
// site-wide for free (one extra query against a table that already
// exists), unlike the per-batch-only checks above.
export async function detectDuplicateTitles(siteId, batchResults) {
  const known = await listTitlesForSite(siteId);
  const byTitle = new Map();
  const record = (page, title, impressions) => {
    if (!title) return;
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push({ page, impressions: impressions || 0 });
  };
  for (const r of known) record(r.page, r.title, r.last_impressions);
  for (const r of batchResults) record(r.page, r.technicalAudit?.title, r.impressions);

  const duplicateGroups = [];
  for (const [title, entries] of byTitle) {
    const uniquePages = [...new Map(entries.map((e) => [e.page, e])).values()];
    if (uniquePages.length >= 2) duplicateGroups.push({ title, pages: uniquePages });
  }
  return duplicateGroups;
}

// Follows redirects manually (never fetch()'s automatic follow) so the real
// hop chain is observable — needed to tell "redirects once, fine" apart
// from "redirects 5 times, a real crawl-budget problem." Every hop target
// (not just the first request) is checked against isPrivateOrLocalHost —
// a same-host redirect could in principle point at a private/internal
// address even when the original href looked like a normal same-site link.
async function followRedirects(startUrl, maxHops = MAX_REDIRECT_HOPS) {
  const chain = [];
  let current = startUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    let hostname;
    try { hostname = new URL(current).hostname; } catch { return { chain, finalStatus: null, hops: chain.length, error: 'invalid URL' }; }
    if (isPrivateOrLocalHost(hostname)) return { chain, finalStatus: null, hops: chain.length, error: 'blocked: private/local address' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIRECT_HOP_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: controller.signal, headers: UA_HEADER });
      if (res.status === 405) { // some servers reject HEAD outright
        res = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: UA_HEADER });
      }
    } catch (err) {
      return { chain, finalStatus: null, hops: chain.length, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
    } finally {
      clearTimeout(timeout);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      chain.push({ url: current, status: res.status });
      current = new URL(location, current).href;
      continue;
    }
    chain.push({ url: current, status: res.status });
    return { chain, finalStatus: res.status, hops: chain.length - 1, error: null };
  }
  return { chain, finalStatus: null, hops: maxHops, error: 'exceeded max redirect hops' };
}

// Crawls only the real internal links found ON this run's rotation batch —
// not an exhaustive whole-site crawl (that's a real queue+politeness
// subsystem, out of scope for a synchronous daily agent run). Bounded to
// MAX_LINK_CHECKS_PER_DAY total checks regardless of how many links the
// batch's pages contain.
export async function crawlInternalLinks(pageResults, maxChecks = MAX_LINK_CHECKS_PER_DAY) {
  const sourcesByHref = new Map(); // href -> Set(sourcePage)
  for (const r of pageResults) {
    for (const href of r.analysis?.internalLinks || []) {
      if (!sourcesByHref.has(href)) sourcesByHref.set(href, new Set());
      sourcesByHref.get(href).add(r.page);
    }
  }
  const hrefs = [...sourcesByHref.keys()].slice(0, maxChecks);

  const results = await Promise.all(hrefs.map(async (href) => {
    const r = await followRedirects(href);
    return { href, sourcePages: [...sourcesByHref.get(href)], ...r };
  }));

  const broken = results.filter((r) => r.error || (r.finalStatus != null && r.finalStatus >= 400));
  const redirectChains = results.filter((r) => !r.error && r.hops >= LONG_CHAIN_HOP_THRESHOLD);
  return { checked: results.length, broken, redirectChains };
}
