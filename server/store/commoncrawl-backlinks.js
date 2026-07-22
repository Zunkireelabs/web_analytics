import { query } from '../db.js';

// Persistence for the Common Crawl backlinks ETL (server/scripts/refresh-
// commoncrawl-graph.js — migrations 044/045). This module is the only thing
// that writes commoncrawl_backlink_domains / commoncrawl_backlink_summary /
// commoncrawl_graph_releases; per the ETL -> providers -> agents -> dashboard
// flow (see migration 044's header comment), everything downstream reads
// through server/providers/backlinks/, never these tables directly.

export async function getGraphRelease(graphRelease) {
  const { rows } = await query(
    'SELECT * FROM commoncrawl_graph_releases WHERE graph_release = $1',
    [graphRelease]
  );
  return rows[0] || null;
}

// The one release, if any, a previous run started but didn't finish — lets
// the ETL resume that release instead of re-resolving "latest" and
// potentially jumping ahead to a newer release mid-work.
export async function getIncompleteGraphRelease() {
  const { rows } = await query(
    `SELECT * FROM commoncrawl_graph_releases
      WHERE status IN ('running', 'failed')
      ORDER BY started_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

// Idempotent: a re-run for the same release that already has a row (e.g.
// left 'running' by a crash) reuses it instead of erroring, so the ETL can
// resume rather than restart.
export async function getOrCreateGraphRelease(graphRelease, { verticesUrl, edgesUrl, ranksUrl }) {
  const existing = await getGraphRelease(graphRelease);
  if (existing) return existing;
  const { rows } = await query(
    `INSERT INTO commoncrawl_graph_releases (graph_release, vertices_url, edges_url, ranks_url)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [graphRelease, verticesUrl, edgesUrl, ranksUrl]
  );
  return rows[0];
}

export async function updateGraphReleaseProgress(graphRelease, patch) {
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(patch)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return;
  values.push(graphRelease);
  await query(
    `UPDATE commoncrawl_graph_releases SET ${sets.join(', ')} WHERE graph_release = $${values.length}`,
    values
  );
}

export async function completeGraphRelease(graphRelease, stats = {}) {
  await updateGraphReleaseProgress(graphRelease, { ...stats, status: 'completed', finished_at: new Date() });
}

export async function failGraphRelease(graphRelease, errorMessage) {
  await updateGraphReleaseProgress(graphRelease, {
    status: 'failed',
    error_message: errorMessage,
    finished_at: new Date(),
  });
}

// Whether the ETL has ever finished a release — lets the API (routes/
// commoncrawl-backlinks.js) tell "the import has simply never run" apart
// from "the import ran, but this specific domain isn't in it".
export async function hasCompletedGraphRelease() {
  const { rows } = await query(
    `SELECT 1 FROM commoncrawl_graph_releases WHERE status = 'completed' LIMIT 1`
  );
  return rows.length > 0;
}

// Chunked multi-row INSERT, same pattern as store/audit-runs.js's
// saveAuditPageFindingsBatch — the edges file can produce millions of
// matching rows for a well-linked site, so one INSERT per row isn't viable.
// ON CONFLICT DO NOTHING is the "skip duplicates safely" requirement: a
// resumed/re-run import re-streams edges it already stored, and the
// (target_domain, source_domain, graph_release) unique constraint (migration
// 044) makes re-inserting them a no-op instead of an error.
const INSERT_CHUNK_SIZE = 500;
const COLUMNS_PER_ROW = 3;
export async function insertBacklinkDomainsBatch(rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const values = [];
    const rowPlaceholders = chunk.map((r, idx) => {
      values.push(r.targetDomain, r.sourceDomain, r.graphRelease);
      const base = idx * COLUMNS_PER_ROW;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });
    await query(
      `INSERT INTO commoncrawl_backlink_domains (target_domain, source_domain, graph_release)
       VALUES ${rowPlaceholders.join(', ')}
       ON CONFLICT (target_domain, source_domain, graph_release) DO NOTHING`,
      values
    );
  }
}

// Real referring-domain count for this release, straight from the rows just
// stored — never a guessed/estimated number.
export async function countReferringDomains(targetDomain, graphRelease) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT source_domain)::int AS count
       FROM commoncrawl_backlink_domains
      WHERE target_domain = $1 AND graph_release = $2`,
    [targetDomain, graphRelease]
  );
  return rows[0].count;
}

export async function upsertBacklinkSummary({ domain, referringDomains, graphRank, graphRelease }) {
  await query(
    `INSERT INTO commoncrawl_backlink_summary (domain, referring_domains, graph_rank, graph_release, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (domain, graph_release) DO UPDATE SET
       referring_domains = EXCLUDED.referring_domains,
       graph_rank = EXCLUDED.graph_rank,
       updated_at = now()`,
    [domain, referringDomains, graphRank ?? null, graphRelease]
  );
}
