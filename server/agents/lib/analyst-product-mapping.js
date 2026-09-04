import { getQueriesForPage } from '../../store/read.js';
import { getProductCapabilities } from '../../store/data-analyst.js';
import { relatesToCapability } from './analyst-seo-mapping.js';

// The product-awareness layer the fusion engine needs, built entirely on
// what already exists: analyst-seo-mapping.js's buildProductTopicMap already
// aggregates capability <-> keyword-cluster/gap relevance for the Analyst
// page; classifyGapRelevance + findExistingPageMatch already classify a
// content gap's intent/relevance and existing coverage at approval time
// (createActionCenterRecommendationForGap). This module adds the missing
// piece: mapping a SPECIFIC, ALREADY-RANKING page (a decline-risk subject,
// which by definition has an existing page — it wouldn't be "declining" if
// it didn't exist) onto the same verified-capability list, so a fused
// decline-risk conclusion can say which product it threatens, not just that
// a page is falling.
//
// EXTENSIBLE ON PURPOSE: everything here reads product_capabilities
// (migration 111, the Product Understanding Layer) — the same source of
// truth every other product-aware surface in this codebase already reads.
// If that table is incomplete for a site, the honest fix is adding rows to
// it (via the capabilities form or connect-site onboarding), not hardcoding
// a fallback list here — a hardcoded list is exactly the "only aware of one
// product" gap this layer exists to remove.

// Verified capabilities are read once per fusion run by the caller and
// passed in here, not re-fetched per page — same discipline
// syncAnalystInsightsToActionCenter's `gates` instance already applies for a
// different per-run cache.
export async function loadVerifiedCapabilities(siteId) {
  return getProductCapabilities(siteId, 'verified');
}

// A page's own real top queries (GSC — not modelled) are what tie it to a
// capability. `days`/`limit` mirror getQueriesForPage's own defaults except
// widened slightly (8 not 3) so a thin page still has enough queries to
// match against.
export async function mapPageToProduct(siteId, page, capabilities) {
  if (!capabilities?.length) {
    return { capability: null, relevance: 'unmapped', topQueries: [], reason: 'no verified product capabilities recorded for this site yet' };
  }
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const rows = await getQueriesForPage(siteId, start, end, page, 8).catch(() => []);
  const topQueries = rows.map((r) => r.query).filter(Boolean);

  if (!topQueries.length) {
    return { capability: null, relevance: 'unmapped', topQueries: [], reason: 'no recent GSC queries recorded for this page' };
  }

  // "direct" wins outright over "supporting": a page matching a capability's
  // own name/category by any real query is a stronger claim than a page that
  // merely shares an industry word, so direct is checked as its own pass
  // rather than folded into one score.
  for (const capability of capabilities) {
    if (topQueries.some((q) => relatesToCapability(q, capability))) {
      return { capability, relevance: 'direct', topQueries, reason: null };
    }
  }
  return { capability: null, relevance: 'unmapped', topQueries, reason: 'no verified capability matches this page\'s real queries' };
}

// One-line, human-facing statement of the mapping — this is the sentence the
// 9-question narrative's "what is causing/contributing" and "which surface"
// answers are built from.
export function describeMapping(mapping, page) {
  if (!mapping.capability) {
    return `No verified Zunkiree product capability matches ${page}'s real ranking queries` +
      (mapping.reason ? ` (${mapping.reason})` : '') + '. This may mean the product-capability list needs a new entry, not that no product relates to it.';
  }
  return `This page's ranking queries relate directly to the "${mapping.capability.name}" capability` +
    (mapping.capability.category ? ` (${mapping.capability.category})` : '') + '.';
}
