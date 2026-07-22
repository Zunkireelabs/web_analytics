import { fetchLatestSummary, fetchReferringDomainsForRelease } from '../../ingest/commoncrawl-backlinks.js';

// Common Crawl implementation of the BacklinkProvider contract (./provider.js)
// — reads only from this app's own database, populated by
// server/scripts/refresh-commoncrawl-graph.js. No network requests here; see
// server/ingest/dataforseo-backlinks.js for the separate, live-API DataForSEO
// integration this provider does not replace.
//
// Common Crawl's webgraph only supports referring-domain counts and a graph
// rank per release — it carries no per-link detail. So, unlike DataForSEO's
// backlinks API, this provider deliberately never returns anchor text,
// follow/nofollow status, individual backlink URLs, or referring IPs/subnets
// — there is no real data behind any of those here, and fabricating them
// would misrepresent a free, coarser data source as the paid one.

export const id = 'commoncrawl';

// No credentials or live endpoint to check — this provider only ever reads
// its own database, so it is always "configured" in the sense DataForSEO's
// configured() means (has what it needs to attempt serving data). Whether a
// specific domain actually has imported data is a separate, per-domain
// question answered by fetchDomainSummary returning null.
export function configured() {
  return true;
}

// Consistent with the existing agent framework's insufficient-data
// convention (see server/agents/authority.js / server/ingest/dataforseo-
// backlinks.js's fetchBacklinkSummary): null means "no real data for this
// domain yet" — a domain never imported, or not yet matched by any Common
// Crawl release — never a fabricated zero/placeholder summary. A future
// agent built on this provider maps this the same way authority.js maps a
// null domain: straight to `status: 'insufficient-data'`.
export async function fetchDomainSummary(domain) {
  const row = await fetchLatestSummary(domain);
  if (!row) return null;
  return {
    domain: row.domain,
    referringDomains: row.referring_domains,
    graphRank: row.graph_rank != null ? Number(row.graph_rank) : null,
    graphRelease: row.graph_release,
    updatedAt: row.updated_at.toISOString(),
  };
}

// Empty array (not null) for "nothing to list" — same list-vs-object
// convention as dataforseo-backlinks.js's fetchTopLinkedPages/
// fetchAnchorDistribution.
export async function fetchReferringDomains(domain) {
  const summary = await fetchLatestSummary(domain);
  if (!summary) return [];
  const rows = await fetchReferringDomainsForRelease(domain, summary.graph_release);
  return rows.map((r) => ({ sourceDomain: r.source_domain, graphRelease: r.graph_release }));
}
