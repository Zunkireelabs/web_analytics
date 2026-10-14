import { fetchDomainSummary } from '../../providers/backlinks/commoncrawl.js';
import { configured as dataForSeoBacklinksConfigured, fetchBacklinkSummary } from '../../ingest/dataforseo-backlinks.js';

// Real referring-domain comparison across this site and its tracked
// competitors — prefers the already-paid-for DataForSEO Backlinks API (same
// product/credentials as authority.js's Authority Score) when configured,
// since it's a real per-domain lookup rather than a free but coarser
// dataset. Common Crawl (server/providers/backlinks/commoncrawl.js,
// populated by server/scripts/refresh-commoncrawl-graph.js) is the fallback
// for a domain when DataForSEO isn't configured or its own lookup fails —
// never a fabricated number for a domain neither source has data for. A
// domain with no real summary from either source is simply excluded from
// the comparison (see missingDomains), never assigned a guessed/zero
// placeholder. This runs once per site's monthly competitor-intelligence
// analysis (own domain + up to MAX_COMPETITORS domains, see
// competitor-analysis.js), never per dashboard page load.
//
// graphRank (Common Crawl only — DataForSEO's summary has no equivalent) is
// surfaced as-is for context but never used to decide "who's ahead" — per
// its own contract (server/providers/backlinks/provider.js), its direction
// ("lower/higher is better") is provider-specific and not something to
// assume. referringDomains (an unambiguous count, from whichever source
// answered) is the only metric this module ranks domains by.

async function summaryFor(domain) {
  if (dataForSeoBacklinksConfigured()) {
    const summary = await fetchBacklinkSummary(domain).catch(() => null);
    // DataForSEO's summary has no updatedAt of its own (unlike Common
    // Crawl's, which reflects the graph release date) — this is a real-time
    // lookup, so "now" is the accurate answer to "when was this fetched."
    if (summary?.referringDomains != null) {
      return { domain, source: 'dataforseo', updatedAt: new Date().toISOString(), ...summary };
    }
  }
  const summary = await fetchDomainSummary(domain);
  return summary ? { domain, source: 'commoncrawl', ...summary } : null;
}

// `ownDomain`/`competitorDomains` are whatever competitor-analysis.js's
// runCompetitorDiscovery already identified — this module never discovers
// competitors itself, only compares real backlink data for domains already
// found by that pipeline.
export async function buildBacklinkComparison(ownDomain, competitorDomains) {
  const domains = [...new Set([ownDomain, ...competitorDomains].filter(Boolean))];
  const results = await Promise.all(domains.map(summaryFor));

  const own = results.find((r) => r?.domain === ownDomain) || null;
  const competitors = results.filter((r) => r && r.domain !== ownDomain);
  const missingDomains = domains.filter((d, i) => d !== ownDomain && !results[i]);

  // Requirement: continue reporting insufficient-data (never fabricate) when
  // the site's own domain or every competitor is absent from both real
  // sources — there's no real comparison to make without both sides.
  if (!own || !competitors.length) {
    return {
      status: 'insufficient-data',
      source: dataForSeoBacklinksConfigured() ? 'dataforseo' : 'commoncrawl',
      message: !own
        ? "This site's own domain has no real referring-domain data yet."
        : 'None of the identified competitors have real referring-domain data yet.',
      ownDomain: own,
      competitors: [],
      missingDomains,
      strongestProfile: null,
      largestGap: null,
      opportunities: [],
    };
  }

  const all = [own, ...competitors];
  const strongestProfile = all.reduce((best, c) => (c.referringDomains > best.referringDomains ? c : best));

  // Only a competitor that genuinely out-counts the site's own referring
  // domains counts as a real "gap" — if the site leads every competitor with
  // real data, there is no gap to report, never an invented one.
  const gaps = competitors
    .map((c) => ({ domain: c.domain, gap: c.referringDomains - own.referringDomains, graphRelease: c.graphRelease }))
    .filter((g) => g.gap > 0)
    .sort((a, b) => b.gap - a.gap);

  const largestGap = gaps[0] || null;
  // The smaller, more achievable gaps (excluding the single largest, already
  // reported above) — a realistic near-term catch-up target, still a real
  // computed deficit, not a suggested tactic.
  const opportunities = gaps.slice(1, 3);

  return {
    status: 'ok',
    source: own.source,
    message: null,
    ownDomain: own,
    competitors,
    missingDomains,
    strongestProfile,
    largestGap,
    opportunities,
  };
}
