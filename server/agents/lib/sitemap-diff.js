import { createHash } from 'crypto';
import { makeFinding } from './findings.js';
import { makeVerification, VERDICT } from './verdict.js';
import { probeMany, isSelfCanonical, normalizeUrlForCompare } from './live-probe.js';
import { effortForGenerator } from './page-content.js';

// Pure helpers factored out of agents/sitemap.js so the actual diff/
// fingerprint/finding-building logic is unit-testable without a real
// database — same "DB-fetch stays in the agent, real logic lives in a
// testable lib" split as technical-seo.js/lib/technical-seo-analysis.js.

// Deterministic fingerprint over a sorted, deduped string set — the same
// set, regardless of input order, always produces the same value, so a
// re-run with an unchanged missing-URL set reuses the exact same finding id
// (see store/drafts.js's getDraftByFindingId idempotency, which every
// existing generator already relies on for dedup) instead of creating a
// duplicate finding/draft. A changed set changes the fingerprint, so a
// genuinely new missing URL surfaces as a new finding rather than being
// silently absorbed into an already-drafted one — this is the fix for the
// exact duplicate-draft behavior previously seen with llms-txt.
export function fingerprintSet(items) {
  const sorted = [...new Set(items)].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

// Same real page compared under a trailing-slash or http/https difference
// (both harmless, both common — a sitemap generator and the real crawl that
// built page_inventory don't always agree on either) must never register as
// "missing from the sitemap". Falls back to the raw string unchanged on
// anything that isn't a real absolute URL (e.g. a bare path in a unit test)
// rather than throwing, so this stays a strict tightening, never a new way
// to under- or over-match.
function normalizeForCompare(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
  } catch { return url; }
}

// Which known pages (this site's own page_inventory) aren't in the live
// sitemap yet — pure diff, no DB/HTTP access; callers supply already-fetched
// data so this can never see another site's rows.
export function computeMissingUrls(inventoryPages, sitemapEntries) {
  const sitemapUrlSet = new Set(sitemapEntries.map((e) => normalizeForCompare(e.loc)));
  return [...new Set(inventoryPages)].filter((page) => !sitemapUrlSet.has(normalizeForCompare(page))).sort();
}

// The host the sitemap itself calls canonical: the most common hostname among
// its own <loc> entries (a sitemap is authoritative about which host owns the
// site; zunkireelabs.com's www host answers EVERY path with a 301, so www rows
// in page_inventory are aliases, not pages). Null when there are no entries.
export function dominantHost(sitemapEntries) {
  const counts = new Map();
  for (const e of sitemapEntries) {
    try { const h = new URL(e.loc).hostname.toLowerCase(); counts.set(h, (counts.get(h) || 0) + 1); } catch { /* skip */ }
  }
  let best = null;
  for (const [h, n] of counts) if (!best || n > best[1]) best = [h, n];
  return best ? best[0] : null;
}

// Cheap, no-network pre-filter: a URL can only be "missing from the sitemap"
// if it is a clean candidate for being listed at all — on the canonical host,
// http(s), and without a query string (?query variants are never sitemap
// material and are the duplicate-detectors' concern).
export function isSitemapCandidate(url, canonicalHost) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.search || u.hash) return false;
    if (canonicalHost && u.hostname.toLowerCase() !== canonicalHost) return false;
    return true;
  } catch { return false; }
}

// Live-verifies computeMissingUrls' output. Only URLs that return 200 at the
// requested address (no redirect), on the canonical host, with no query
// string, and whose declared canonical (if any) is themselves are CONFIRMED
// missing. Everything else is dropped with a reason; a probe that could not
// observe the URL is `unverifiable` and never asserted. At most `maxProbes`
// URLs are probed per run; the window rotates by `seed` (e.g. day number) so
// a head of permanently-dead rows cannot starve the rest.
export async function verifyMissingUrls(candidates, { canonicalHost = null, maxProbes = 40, seed = 0, probe } = {}) {
  const dropped = [];
  const eligible = [];
  for (const url of candidates) {
    if (isSitemapCandidate(url, canonicalHost)) eligible.push(url);
    else dropped.push({ url, reason: 'not-a-sitemap-candidate' });
  }
  const sorted = [...eligible].sort();
  const offset = sorted.length ? (Math.abs(seed) * maxProbes) % sorted.length : 0;
  const rotated = [...sorted.slice(offset), ...sorted.slice(0, offset)];
  const { results, skipped } = await probeMany(rotated, { maxProbes, checkCanonical: true, ...(probe ? { probe } : {}) });

  const confirmed = [];
  const unverifiable = [];
  for (const r of results) {
    if (r.verdict === 'unverifiable') unverifiable.push(r.url);
    else if (r.verdict !== 'live') dropped.push({ url: r.url, reason: r.verdict });
    else if (!isSelfCanonical(r)) dropped.push({ url: r.url, reason: 'canonicalized-elsewhere' });
    else confirmed.push(r.url);
  }
  return { confirmed: confirmed.sort(), dropped, unverifiable, skipped };
}

export { normalizeUrlForCompare };

// One aggregated, fingerprinted finding for a site's missing sitemap URLs —
// null when there's nothing missing (no finding, no Action Center noise).
// Orphaned URLs are surfaced in evidence/whyItMatters for manual review only
// — never turned into a removal action.
export function buildMissingUrlsFinding({ sitemapPath, missingUrls, orphanedUrls }) {
  if (!missingUrls.length) return null;
  const fingerprint = fingerprintSet(missingUrls);
  const whyItMatters = `${missingUrls.length} discovered URL${missingUrls.length === 1 ? ' is' : 's are'} missing from the sitemap.` +
    (orphanedUrls.length
      ? ` Also, ${orphanedUrls.length} URL${orphanedUrls.length === 1 ? '' : 's'} already in the sitemap ${orphanedUrls.length === 1 ? 'was' : 'were'} not reached by the crawl and should be reviewed manually — not removed automatically.`
      : '');
  return makeFinding({
    id: `sitemap:site:missing-urls:${fingerprint}`,
    evidence: { missingUrls, missingCount: missingUrls.length, orphanedUrls, orphanedCount: orphanedUrls.length, sitemapPath },
    whyItMatters,
    priority: 'medium',
    verification: makeVerification(VERDICT.CONFIRMED, 'http-probe', 'each listed URL returned 200 live on the canonical host with no query string and a self-referencing canonical'),
    recommendedAction: {
      label: 'Update sitemap',
      generatorId: 'sitemap',
      params: { missingUrls },
      effort: effortForGenerator('sitemap'),
    },
    expectedImpact: { label: 'Medium', basis: 'computed', value: missingUrls.length },
  });
}
