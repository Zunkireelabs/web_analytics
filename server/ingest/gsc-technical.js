import { getSearchConsole } from '../auth/google.js';

// GSC's URL Inspection + Sitemaps APIs — both already covered by the
// existing `webmasters.readonly` OAuth scope (server/auth/google.js), never
// called anywhere until now. Real per-page index status (the "Coverage"
// report's modern replacement) and real sitemap submission/processing
// health, for server/agents/technical-seo.js.
//
// Both functions never throw — they're called once per page in a rotation
// batch (see agents/lib/technical-seo-analysis.js), and one page's
// inspection failing (quota, transient error) should degrade that one
// page's result, not abort the whole batch. Same {ok, error} convention as
// analyzePageUrl (agents/lib/page-content.js).

export async function inspectUrl(site, pageUrl) {
  try {
    const sc = await getSearchConsole(site);
    const res = await sc.urlInspection.index.inspect({
      requestBody: { inspectionUrl: pageUrl, siteUrl: site.gsc_property },
    });
    const r = res.data?.inspectionResult?.indexStatusResult;
    if (!r) return { ok: false, error: 'no inspection result returned' };
    return {
      ok: true,
      // GSC's own PASS/PARTIAL/FAIL/NEUTRAL verdict — a cleaner, more
      // reliable "is this actually a problem" signal than pattern-matching
      // coverageState's free-text values (which include legitimate,
      // non-problem states like "Alternate page with proper canonical tag").
      verdict: r.verdict ?? null,
      coverageState: r.coverageState ?? null,
      indexingState: r.indexingState ?? null,
      robotsTxtState: r.robotsTxtState ?? null,
      pageFetchState: r.pageFetchState ?? null,
      googleCanonical: r.googleCanonical ?? null,
      userCanonical: r.userCanonical ?? null,
      lastCrawlTime: r.lastCrawlTime ?? null,
    };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    return {
      ok: false,
      quotaExceeded: status === 429 || String(err?.message || '').includes('RESOURCE_EXHAUSTED'),
      error: String(err?.message || err),
    };
  }
}

// Real submitted-sitemap health, whole-site (not per-page — one call
// regardless of how many pages this run's rotation batch covers).
export async function listSitemaps(site) {
  try {
    const sc = await getSearchConsole(site);
    const res = await sc.sitemaps.list({ siteUrl: site.gsc_property });
    const entries = res.data?.sitemap || [];
    return {
      ok: true,
      sitemaps: entries.map((s) => ({
        path: s.path,
        isPending: !!s.isPending,
        isSitemapsIndex: !!s.isSitemapsIndex,
        lastSubmitted: s.lastSubmitted ?? null,
        lastDownloaded: s.lastDownloaded ?? null,
        errors: Number(s.errors) || 0,
        warnings: Number(s.warnings) || 0,
      })),
    };
  } catch (err) {
    return { ok: false, sitemaps: [], error: String(err?.message || err) };
  }
}
