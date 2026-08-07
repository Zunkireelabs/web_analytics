import { getSearchConsole } from '../auth/google.js';
import { prioritizeForRecheck } from '../store/technical-seo-checks.js';
import { safeMessage } from '../lib/errors.js';

// GSC's URL Inspection + Sitemaps APIs — covered by the `webmasters` OAuth
// scope (server/auth/google.js). Real per-page index status (the "Coverage"
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
    const { message } = safeMessage('gsc-technical.inspectUrl', err, 'this page could not be inspected right now');
    return {
      ok: false,
      quotaExceeded: status === 429 || String(err?.message || '').includes('RESOURCE_EXHAUSTED'),
      error: message,
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
    const { message } = safeMessage('gsc-technical.listSitemaps', err, 'sitemap status could not be checked right now');
    return { ok: false, sitemaps: [], error: message };
  }
}

// Real "please recheck this sitemap soon" nudge — the legitimate, policy-
// safe mechanism for asking Google to reprocess changed content (unlike
// the Indexing API, which Google officially restricts to JobPosting/
// BroadcastEvent content; calling it for ordinary pages isn't reliably
// honored and risks the property being flagged for misuse). NOT a
// guarantee of immediate reindexing, and NOT per-URL — it's whole-sitemap.
//
// This is a WRITE call, requiring the `webmasters` (not `.readonly`) scope
// (SCOPES in server/auth/google.js). A site whose connection still predates
// that scope upgrade — or a per-site service-account credential that was
// never granted write access — gets a clean `reason: 'insufficient-scope'`
// here rather than a thrown error.
export async function submitSitemap(site, feedpath) {
  try {
    const sc = await getSearchConsole(site);
    await sc.sitemaps.submit({ siteUrl: site.gsc_property, feedpath });
    return { ok: true };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    const insufficientScope = status === 403 || String(err?.message || '').includes('insufficient authentication scopes');
    const { message } = safeMessage('gsc-technical.submitSitemap', err, 'this sitemap could not be resubmitted right now');
    return {
      ok: false,
      reason: insufficientScope ? 'insufficient-scope' : 'google-api-error',
      error: insufficientScope
        ? 'This site\'s Search Console connection only has read access — ask an admin to grant write (webmasters) scope before sitemap resubmission can work.'
        : message,
    };
  }
}

// Called after a draft's merge actually lands — the real "tell Search
// Console about this" step (multi-tenant refactor, Part 3). Two real,
// independent actions, both best-effort (never throws, so a notification
// failure never blocks the merge response that already succeeded):
//   1. Prioritize the changed page for technical-seo's next rotation batch
//      (see prioritizeForRecheck's doc comment for why this, not a
//      synchronous inspectUrl call, is the quota-safe choice).
//   2. Attempt real sitemap resubmission against whatever sitemap(s) this
//      site's OWN Search Console property already has registered (never a
//      guessed path) — honestly reports insufficient-scope today (see
//      submitSitemap) rather than silently no-op'ing.
// No site.gsc_property configured at all -> real no-op, not an error (the
// same "insufficient-data" discipline every agent in this codebase uses).
export async function notifyOfPageChange(site, page) {
  if (!site.gsc_property) return { skipped: true, reason: 'no-gsc-property' };

  await prioritizeForRecheck(site.id, page);

  const sitemaps = await listSitemaps(site);
  if (!sitemaps.ok || !sitemaps.sitemaps.length) {
    return { prioritizedRecheck: true, sitemapSubmit: { ok: false, reason: 'no-sitemap-registered', error: sitemaps.error || 'No sitemap registered in Search Console for this property yet.' } };
  }
  const sitemapSubmit = await submitSitemap(site, sitemaps.sitemaps[0].path);
  return { prioritizedRecheck: true, sitemapSubmit };
}
