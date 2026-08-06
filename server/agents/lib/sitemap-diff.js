import { createHash } from 'crypto';
import { makeFinding } from './findings.js';
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
    recommendedAction: {
      label: 'Update sitemap',
      generatorId: 'sitemap',
      params: { missingUrls },
      effort: effortForGenerator('sitemap'),
    },
    expectedImpact: { label: 'Medium', basis: 'computed', value: missingUrls.length },
  });
}
