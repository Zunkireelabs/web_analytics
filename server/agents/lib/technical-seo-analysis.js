import { analyzePageUrl, isPrivateOrLocalHost, fetchResponseHeaders, isCompressedEncoding } from './page-content.js';
import { inspectUrl } from '../../ingest/gsc-technical.js';
import { fetchCoreWebVitals, configured as pagespeedConfigured } from '../../ingest/pagespeed.js';
import { listTitlesForSite } from '../../store/technical-seo-checks.js';
import { describeFetchFailure } from '../../lib/errors.js';

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
// Retry identity for a link that failed under UA_HEADER's self-identifying
// bot UA — a real browser UA and a longer timeout, tried once before a link
// is actually reported broken. Confirmed live: linkedin.com/company/zunkiree
// and a Couchbase blog post both 403'd under the bot UA while returning a
// real 200 under this one — sites with bot-protection routinely block an
// unfamiliar UA string even though the page is genuinely live to visitors.
// braindigit.com/truemark.dev/upaya.org all 200'd on retry too, after the
// bot UA's 5s REDIRECT_HOP_TIMEOUT_MS timed out on them — not dead, just
// slower to respond than this codebase's own crawler budget assumes. Two of
// these false positives had already shipped as real PRs deleting live
// citations (drafts 766/767, zunkireelabs-web PR #53) before this was
// caught, which is why this is a retry-before-reporting-broken, not merely
// a longer default timeout: a citation getting DELETED from real content on
// a false positive is a correctness bug, not just noisy reporting.
const BROWSER_RETRY_UA_HEADER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const RETRY_TIMEOUT_MS = 12000;
// Soft-404 detection guardrail: a fully client-side-rendered site can serve
// the identical shell for every route, real or not — in that world this
// heuristic would flag everything, so a suspiciously high match rate across
// a real sample disables it for the run rather than flooding false positives.
const SOFT_404_MIN_SAMPLE = 5;
const SOFT_404_BAILOUT_RATIO = 0.5;

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
    const [pageAnalysis, indexStatus, coreWebVitals, headers] = await Promise.all([
      fetchPage(page),
      inspectUrl(site, page),
      pagespeedConfigured()
        ? fetchCoreWebVitals(page).catch((err) => ({ ok: false, error: describeFetchFailure('technical-seo-analysis.fetchCoreWebVitals', err) }))
        : Promise.resolve({ ok: false, error: 'not-configured' }),
      // Separate, lightweight headers-only fetch (no body read) — real
      // Content-Encoding, not guessed from response size or file extension.
      fetchResponseHeaders(page).catch((err) => ({ ok: false, error: describeFetchFailure('technical-seo-analysis.fetchResponseHeaders', err) })),
    ]);
    return {
      page,
      analysis: pageAnalysis.ok ? pageAnalysis.analysis : null,
      technicalAudit: pageAnalysis.ok
        ? { ok: true, hasCanonical: pageAnalysis.analysis.hasCanonical, hasSchema: pageAnalysis.analysis.hasSchema, schemaTypes: pageAnalysis.analysis.schemaTypes, title: pageAnalysis.analysis.title }
        : { ok: false, error: pageAnalysis.error },
      indexStatus,
      coreWebVitals,
      compression: headers.ok
        ? { ok: true, compressed: isCompressedEncoding(headers.headers.get('content-encoding')) }
        : { ok: false, error: headers.error },
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
async function followRedirects(startUrl, maxHops = MAX_REDIRECT_HOPS, headers = UA_HEADER, timeoutMs = REDIRECT_HOP_TIMEOUT_MS) {
  const chain = [];
  let current = startUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    let hostname;
    try { hostname = new URL(current).hostname; } catch { return { chain, finalStatus: null, hops: chain.length, error: 'invalid URL' }; }
    if (isPrivateOrLocalHost(hostname)) return { chain, finalStatus: null, hops: chain.length, error: 'blocked: private/local address' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: controller.signal, headers });
      if (res.status === 405) { // some servers reject HEAD outright
        res = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers });
      }
    } catch (err) {
      return { chain, finalStatus: null, hops: chain.length, error: describeFetchFailure('technical-seo-analysis.followRedirects', err) };
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

// A link only gets reported broken after failing TWICE: once under
// UA_HEADER's self-identifying bot UA at the normal timeout (the fast path
// that resolves the overwhelming majority of real links), and — only if
// that failed outright or came back 403/429/503 — once more under a real
// browser UA and a longer timeout. These three statuses are deliberately
// included alongside outright failures: bot-protected sites (LinkedIn,
// Cloudflare-fronted blogs) return 403 specifically FOR an unfamiliar bot
// UA while serving a real 200 to an ordinary browser, and the same
// bot-protection stacks just as often answer an unrecognized crawler with
// 429 (rate-limited) or 503 (temporarily unavailable) instead — both are
// UA-dependent and transient, not evidence the page is actually gone. Any
// other status (200, 404, 410, …) is trusted on the first attempt —
// retrying those would waste every check's budget doubling requests to
// sites that are answering honestly.
const RETRY_STATUSES = new Set([403, 429, 503]);

// Exported for reuse by agents/redirect-chain.js — that agent walks a
// site's own real pages (not links discovered on a page), but needs the
// exact same manual-redirect-plus-per-hop-SSRF-guard walk, and the same
// bot-protection-aware retry, rather than a second copy of this logic.
export async function followRedirectsWithRetry(startUrl, maxHops = MAX_REDIRECT_HOPS) {
  const first = await followRedirects(startUrl, maxHops);
  if (!first.error && !RETRY_STATUSES.has(first.finalStatus)) return first;
  return followRedirects(startUrl, maxHops, BROWSER_RETRY_UA_HEADER, RETRY_TIMEOUT_MS);
}

function normalizeBody(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// A 2xx status alone doesn't prove a link is real — a static-host/SPA
// catch-all misconfig (confirmed on at least one real site this codebase
// tracks) serves the homepage for ANY unmatched path instead of a true 404.
// Fetches one deliberately-nonexistent path once per crawl run and records
// its status + body, so real internal links can be compared against what
// "doesn't exist" actually looks like on this specific site. Returns null on
// any failure — soft-404 detection is additive, never blocks the real crawl.
export async function fetchSoftNotFoundFingerprint(origin) {
  let hostname;
  try { hostname = new URL(origin).hostname; } catch { return null; }
  if (isPrivateOrLocalHost(hostname)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIRECT_HOP_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/__seo-audit-nonexistent-check__`, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: UA_HEADER });
    const text = await res.text();
    return { status: res.status, text: normalizeBody(text) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// The homepage legitimately renders the same shell a catch-all fallback
// does — that's not brokenness, so it's never compared against the
// fingerprint. Anything else matching the fingerprint's exact status + body
// is treated as a soft 404: it 200'd, but with the "nothing's here" content.
export async function isSoftNotFound(url, fingerprint) {
  if (!fingerprint) return false;
  try { if (new URL(url).pathname === '/') return false; } catch { return false; }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIRECT_HOP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: UA_HEADER });
    if (res.status !== fingerprint.status) return false;
    const text = normalizeBody(await res.text());
    return text === fingerprint.text;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Crawls only the real internal links found ON this run's rotation batch —
// not an exhaustive whole-site crawl (that's a real queue+politeness
// subsystem, out of scope for a synchronous daily agent run). Bounded to
// MAX_LINK_CHECKS_PER_DAY total checks regardless of how many links the
// batch's pages contain.
export async function crawlInternalLinks(pageResults, maxChecks = MAX_LINK_CHECKS_PER_DAY) {
  const sourcesByHref = new Map(); // href -> Set(sourcePage)
  // href -> Set(anchor text). What the site itself calls this destination,
  // collected across every page that links it. dead-link-intent.js needs it
  // to name a page it decides to create; empty when a link is image-only.
  const anchorsByHref = new Map();
  for (const r of pageResults) {
    for (const href of r.analysis?.internalLinks || []) {
      if (!sourcesByHref.has(href)) sourcesByHref.set(href, new Set());
      sourcesByHref.get(href).add(r.page);
    }
    for (const { href, text } of r.analysis?.internalLinkAnchors || []) {
      if (!text) continue;
      if (!anchorsByHref.has(href)) anchorsByHref.set(href, new Set());
      anchorsByHref.get(href).add(text);
    }
  }
  const hrefs = [...sourcesByHref.keys()].slice(0, maxChecks);

  let origin = null;
  for (const r of pageResults) {
    try { origin = new URL(r.page).origin; break; } catch { /* try next page */ }
  }
  const fingerprint = origin ? await fetchSoftNotFoundFingerprint(origin) : null;

  const results = await Promise.all(hrefs.map(async (href) => {
    const r = await followRedirectsWithRetry(href);
    const eligible = !r.error && r.finalStatus != null && r.finalStatus >= 200 && r.finalStatus < 300;
    const softNotFound = eligible && await isSoftNotFound(href, fingerprint);
    return { href, sourcePages: [...sourcesByHref.get(href)], anchorTexts: [...(anchorsByHref.get(href) || [])], ...r, softNotFound };
  }));

  // Bail out on the soft-404 signal entirely if it fired for most of a real
  // sample — that pattern means every route (real or not) looks identical,
  // i.e. a true client-rendered SPA this heuristic can't distinguish, not a
  // site actually full of dead links.
  const eligibleCount = results.filter((r) => !r.error && r.finalStatus >= 200 && r.finalStatus < 300).length;
  const softNotFoundCount = results.filter((r) => r.softNotFound).length;
  const unreliable = eligibleCount >= SOFT_404_MIN_SAMPLE && softNotFoundCount / eligibleCount > SOFT_404_BAILOUT_RATIO;
  if (unreliable) {
    console.warn(`[agents] technical-seo: soft-404 signal looked unreliable (${softNotFoundCount}/${eligibleCount} eligible links matched the fallback fingerprint) — discarding it for this run.`);
  }
  const finalResults = unreliable ? results.map((r) => ({ ...r, softNotFound: false })) : results;

  const broken = finalResults.filter((r) => r.error || (r.finalStatus != null && r.finalStatus >= 400) || r.softNotFound);
  const redirectChains = finalResults.filter((r) => !r.error && r.hops >= LONG_CHAIN_HOP_THRESHOLD);
  // Every source page that had at least one outbound link actually checked
  // this run — as opposed to every page in the batch, most of which never
  // get their links re-verified since crawlInternalLinks caps at
  // MAX_LINK_CHECKS_PER_DAY hrefs total, not per page. Recommendation
  // auto-close (recommendation-coordinator.js) needs this: a page missing
  // from today's broken-link findings only means "fixed" if its links were
  // actually re-checked, not just "not this run's rotation."
  const checkedPages = new Set();
  for (const r of finalResults) for (const p of r.sourcePages) checkedPages.add(p);
  return { checked: finalResults.length, broken, redirectChains, checkedPages: [...checkedPages] };
}

// Same liveness check as crawlInternalLinks, scoped to real EXTERNAL
// citation-style links (page-content.js's externalCitationLinks — the
// `article a[href], main a[href], body a[href]` selector, i.e. real content
// links, not nav/footer boilerplate) instead of internal ones. Deliberately
// no soft-404 check here (that heuristic exists to catch a client-rendered
// SPA fooling itself on ITS OWN routes — meaningless against a third-party
// domain we don't control) and no redirect-chain-length finding (a
// citation redirecting is normal and not the concern; only a genuinely
// dead one is). Bounded the same way, for the same reason: an unbounded
// external crawl on every run would hammer other sites' servers.
export async function crawlExternalCitations(pageResults, maxChecks = MAX_LINK_CHECKS_PER_DAY) {
  const sourcesByHref = new Map(); // href -> Set(sourcePage)
  for (const r of pageResults) {
    for (const href of r.analysis?.externalCitationLinks || []) {
      if (!sourcesByHref.has(href)) sourcesByHref.set(href, new Set());
      sourcesByHref.get(href).add(r.page);
    }
  }
  const hrefs = [...sourcesByHref.keys()].slice(0, maxChecks);

  const results = await Promise.all(hrefs.map(async (href) => {
    const r = await followRedirectsWithRetry(href);
    return { href, sourcePages: [...sourcesByHref.get(href)], ...r };
  }));

  const broken = results.filter((r) => r.error || (r.finalStatus != null && r.finalStatus >= 400));
  const checkedPages = new Set();
  for (const r of results) for (const p of r.sourcePages) checkedPages.add(p);
  return { checked: results.length, broken, checkedPages: [...checkedPages] };
}

// On-demand single-link check for the manual "re-check now" action
// (recommendation-coordinator.js's recheckRecommendation) — same broken
// classification as crawlInternalLinks (status/error/soft-404) but scoped
// to one href instead of a whole page's link crawl, so a user who just
// fixed a specific link can confirm it immediately instead of waiting for
// its page to rotate back into a batch.
export async function recheckLink(href) {
  let origin;
  try { origin = new URL(href).origin; } catch { return { broken: true, error: 'invalid URL', finalStatus: null, softNotFound: false }; }
  const [redirectResult, fingerprint] = await Promise.all([
    followRedirectsWithRetry(href),
    fetchSoftNotFoundFingerprint(origin),
  ]);
  const eligible = !redirectResult.error && redirectResult.finalStatus != null && redirectResult.finalStatus >= 200 && redirectResult.finalStatus < 300;
  const softNotFound = eligible && await isSoftNotFound(href, fingerprint);
  const broken = !!redirectResult.error || (redirectResult.finalStatus != null && redirectResult.finalStatus >= 400) || softNotFound;
  return { broken, finalStatus: redirectResult.finalStatus, error: redirectResult.error, softNotFound };
}
