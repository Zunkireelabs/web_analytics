import { query } from '../db.js';

// Read-only data access for Common Crawl backlink data — the Common Crawl
// counterpart to server/ingest/dataforseo-backlinks.js, except the "source"
// here is this app's own database (populated by
// server/scripts/refresh-commoncrawl-graph.js), not a live API. No network
// requests happen in this file. Writes to commoncrawl_backlink_domains /
// commoncrawl_backlink_summary / commoncrawl_graph_releases belong to the ETL
// script and its store module (server/store/commoncrawl-backlinks.js) —
// this module never inserts or updates anything.
//
// Consumed by server/providers/backlinks/commoncrawl.js, which normalizes
// these rows to the shared BacklinkProvider contract
// (server/providers/backlinks/provider.js).

// A domain can carry rows from more than one past ETL run (the ETL re-runs
// periodically as new Common Crawl releases ship); this always resolves to
// the most recently computed one, never an average/blend across releases.
export async function fetchLatestSummary(domain) {
  const { rows } = await query(
    `SELECT domain, referring_domains, graph_rank, graph_release, updated_at
       FROM commoncrawl_backlink_summary
      WHERE domain = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [domain]
  );
  return rows[0] || null;
}

// Real referring domains for one exact (domain, release) pair — always call
// with the release from fetchLatestSummary(domain) so the list matches
// whatever release the summary counts describe, rather than mixing rows
// imported by different ETL runs.
export async function fetchReferringDomainsForRelease(domain, graphRelease) {
  const { rows } = await query(
    `SELECT source_domain, graph_release
       FROM commoncrawl_backlink_domains
      WHERE target_domain = $1 AND graph_release = $2
      ORDER BY source_domain`,
    [domain, graphRelease]
  );
  return rows;
}
