import { fetchDomainSummary } from '../../providers/backlinks/commoncrawl.js';

// Free Common Crawl referring-domain comparison — a third, always-available,
// no-credential-needed backlink signal alongside competitor-analysis.js's
// LLM/structural comparison and the optional DataForSEO-backed Authority
// Score (authority.js/authority-score.js, both untouched by this file). Only
// ever reads through the commoncrawl provider (server/providers/backlinks/
// commoncrawl.js) — never a network request, never a fabricated number for a
// domain Common Crawl hasn't imported. A domain with no real summary row is
// simply excluded from the comparison (see missingDomains), never assigned a
// guessed/zero placeholder.
//
// graphRank is surfaced as-is for context (task requirement: compare
// referring domains AND graph rank) but never used to decide "who's ahead" —
// per its own contract (server/providers/backlinks/provider.js), its
// direction ("lower/higher is better") is provider-specific and not
// something to assume. referringDomains (an unambiguous count) is the only
// metric this module ranks domains by.

async function summaryFor(domain) {
  const summary = await fetchDomainSummary(domain);
  return summary ? { domain, ...summary } : null;
}

// `ownDomain`/`competitorDomains` are whatever competitor-analysis.js's
// runCompetitorDiscovery already identified — this module never discovers
// competitors itself, only compares Common Crawl data for domains already
// found by that pipeline.
export async function buildBacklinkComparison(ownDomain, competitorDomains) {
  const domains = [...new Set([ownDomain, ...competitorDomains].filter(Boolean))];
  const results = await Promise.all(domains.map(summaryFor));

  const own = results.find((r) => r?.domain === ownDomain) || null;
  const competitors = results.filter((r) => r && r.domain !== ownDomain);
  const missingDomains = domains.filter((d, i) => d !== ownDomain && !results[i]);

  // Requirement: continue reporting insufficient-data (never fabricate) when
  // the site's own domain or every competitor is absent from the Common
  // Crawl dataset — there's no real comparison to make without both sides.
  if (!own || !competitors.length) {
    return {
      status: 'insufficient-data',
      source: 'commoncrawl',
      message: !own
        ? "This site's own domain has no Common Crawl referring-domain data yet."
        : 'None of the identified competitors have Common Crawl referring-domain data yet.',
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
    source: 'commoncrawl',
    message: null,
    ownDomain: own,
    competitors,
    missingDomains,
    strongestProfile,
    largestGap,
    opportunities,
  };
}
