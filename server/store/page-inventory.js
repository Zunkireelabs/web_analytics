import { query } from '../db.js';

// The canonical "every real page we know about" for a site (migration 027).
// `discovered_via` is set only on first insert and never overwritten on
// conflict — first-source is a more honest provenance signal than
// last-source (a page first found by the crawler that a later sitemap run
// also lists stays 'crawl').

export async function upsertPageInventory(siteId, page, discoveredVia) {
  await query(
    `INSERT INTO page_inventory (site_id, page, discovered_via)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, page) DO UPDATE SET last_seen_at = now()`,
    [siteId, page, discoveredVia]
  );
}

// Bulk variant for sitemap/crawl results (can be hundreds of rows) — chunks
// into batches of concurrent single-row upserts rather than hand-building a
// multi-row INSERT, since there's no existing bulk-upsert idiom elsewhere in
// server/store/*.js to match and page counts here are bounded (a few hundred
// at most, per MAX_SITEMAP_URLS/MAX_CRAWL_PAGES in site-discovery.js).
const UPSERT_CHUNK_SIZE = 25;
export async function upsertPageInventoryBatch(siteId, pages, discoveredVia) {
  for (let i = 0; i < pages.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = pages.slice(i, i + UPSERT_CHUNK_SIZE);
    await Promise.all(chunk.map((page) => upsertPageInventory(siteId, page, discoveredVia)));
  }
}

// Recomputed each weekly discovery run from that run's two real, already-
// fetched lists (see server/agents/lib/site-discovery.js's crawlSite /
// discoverFromSitemaps, called from job.js's runSiteDiscoveryIfDue) —
// resets every sitemap-known page for this site to not-orphaned first, then
// flags exactly the ones this run's crawl didn't reach, so a page that gets
// a real internal link added later correctly clears on the next run instead
// of staying flagged forever.
export async function markOrphanedPages(siteId, orphanedUrls) {
  await query(`UPDATE page_inventory SET orphaned = false WHERE site_id = $1`, [siteId]);
  if (!orphanedUrls.length) return;
  await query(
    `UPDATE page_inventory SET orphaned = true WHERE site_id = $1 AND page = ANY($2)`,
    [siteId, orphanedUrls]
  );
}

// Real, currently-flagged orphaned pages for a site — used by
// technical-seo.js to surface a real finding, zero new fetching at
// finding-generation time (the crawl comparison already happened weekly).
export async function listOrphanedPages(siteId, limit = 20) {
  const { rows } = await query(
    `SELECT page, first_seen_at FROM page_inventory WHERE site_id = $1 AND orphaned = true ORDER BY first_seen_at ASC LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function listPageInventory(siteId, { limit = 500 } = {}) {
  const { rows } = await query(
    'SELECT page, discovered_via, first_seen_at, last_seen_at FROM page_inventory WHERE site_id = $1 ORDER BY last_seen_at DESC LIMIT $2',
    [siteId, limit]
  );
  return rows;
}

// Drives the weekly "is a fresh discovery run due" check in job.js, same
// shape as getCompetitorRankingDates driving runCompetitorCheckIfDue.
export async function getLastDiscoveryAt(siteId) {
  const { rows } = await query(
    "SELECT MAX(last_seen_at) AS last_seen_at FROM page_inventory WHERE site_id = $1 AND discovered_via IN ('sitemap', 'crawl')",
    [siteId]
  );
  return rows[0]?.last_seen_at || null;
}
