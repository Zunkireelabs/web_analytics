import * as cheerio from 'cheerio';
import { followRedirectsWithRetry } from './technical-seo-analysis.js';
import { fetchHtml } from './page-content.js';

// Shared "is this inventory URL actually a live, self-canonical page?" probe
// for the detectors that previously reasoned over page_inventory strings
// alone (sitemap.js, url-variant-duplicates.js, query-param-duplicates.js).
// page_inventory is a superset of everything ever seen (crawl + GSC +
// sitemap): it holds 404s, redirecting aliases, other hosts and ?query
// variants, none of which is evidence of a defect on its own.
//
// Verdicts, kept as plain strings so callers can map them onto verdict.js:
//   live         — 200 at the requested URL, no redirect hop
//   redirect     — answered with a 3xx; `redirectsTo` is the final URL
//   dead         — a definitive 404/410
//   unverifiable — error / blocked / 5xx / unreadable, so nothing is asserted
function normalizeForCompare(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
  } catch { return String(url); }
}
export { normalizeForCompare as normalizeUrlForCompare };

// The declared <link rel="canonical"> of a page, absolutized, or null when
// the page declares none. `unreadable: true` when the HTML could not be
// fetched/parsed at all (caller must not treat that as "no canonical").
export async function readCanonical(url, { fetchPage = fetchHtml } = {}) {
  const page = await fetchPage(url);
  if (!page?.ok) return { canonical: null, unreadable: true };
  const href = cheerio.load(page.html)('link[rel="canonical"]').first().attr('href');
  if (!href) return { canonical: null, unreadable: false };
  try { return { canonical: new URL(href, url).href, unreadable: false }; } catch { return { canonical: null, unreadable: false }; }
}

// One bounded probe: follows redirects manually (never trusts a followed
// fetch), classifies, and — only for a live 200 when `checkCanonical` — reads
// the page's own canonical.
export async function probeUrl(url, { checkCanonical = false, followRedirects = followRedirectsWithRetry, fetchPage } = {}) {
  const r = await followRedirects(url);
  if (r.unverifiable || r.error) {
    return { url, verdict: 'unverifiable', status: r.finalStatus ?? null, reason: r.error || 'blocked under every user agent tried' };
  }
  const first = r.chain?.[0]?.status ?? r.finalStatus;
  if (r.hops >= 1) {
    const finalUrl = r.chain?.[r.chain.length - 1]?.url || null;
    return { url, verdict: 'redirect', status: first, redirectsTo: finalUrl, finalStatus: r.finalStatus };
  }
  if (r.finalStatus === 404 || r.finalStatus === 410) return { url, verdict: 'dead', status: r.finalStatus };
  if (r.finalStatus >= 200 && r.finalStatus < 300) {
    if (!checkCanonical) return { url, verdict: 'live', status: r.finalStatus, canonical: null };
    const { canonical, unreadable } = await readCanonical(url, { fetchPage });
    if (unreadable) return { url, verdict: 'unverifiable', status: r.finalStatus, reason: 'page HTML could not be read to check its canonical' };
    return { url, verdict: 'live', status: r.finalStatus, canonical };
  }
  return { url, verdict: 'unverifiable', status: r.finalStatus ?? null, reason: `HTTP ${r.finalStatus} is not proof either way` };
}

// Bounded fan-out: at most `maxProbes` URLs are probed per run, `concurrency`
// at a time. URLs beyond the cap are returned in `skipped` (never asserted).
export async function probeMany(urls, { maxProbes = 40, concurrency = 8, probe = probeUrl, ...opts } = {}) {
  const toProbe = urls.slice(0, maxProbes);
  const skipped = urls.slice(maxProbes);
  const results = new Array(toProbe.length);
  let next = 0;
  const worker = async () => {
    while (next < toProbe.length) {
      const i = next++;
      results[i] = await probe(toProbe[i], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toProbe.length) }, worker));
  return { results, skipped };
}

// A live variant is "its own page" only when it declares no canonical, or
// declares itself.
export function isSelfCanonical(probe) {
  return !probe.canonical || normalizeForCompare(probe.canonical) === normalizeForCompare(probe.url);
}

// Per-run probe budget shared across every group a duplicate detector walks:
// `probeVariants(pages)` probes each page once (concurrently, bounded) and
// returns Map(page -> probe). Once the budget is spent, remaining pages come
// back `unverifiable` (reason 'probe-budget') so nothing is asserted from an
// unobserved URL.
export function createVariantProber({ maxProbes = 60, concurrency = 8, probe = probeUrl, checkCanonical = true } = {}) {
  let used = 0;
  const cache = new Map();
  return async function probeVariants(pages) {
    const todo = [...new Set(pages)].filter((p) => !cache.has(p));
    const allowed = todo.slice(0, Math.max(0, maxProbes - used));
    used += allowed.length;
    for (const p of todo.slice(allowed.length)) cache.set(p, { url: p, verdict: 'unverifiable', reason: 'probe-budget' });
    const { results } = await probeMany(allowed, { maxProbes: allowed.length, concurrency, probe, checkCanonical });
    for (const r of results) cache.set(r.url, r);
    return new Map(pages.map((p) => [p, cache.get(p)]));
  };
}
