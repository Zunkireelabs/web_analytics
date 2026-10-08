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

// Content-hash writes are UPDATE-only, never an upsert that would create a
// row — duplicate-content.js only ever hashes pages selectCandidatePages
// already surfaced (GSC top pages + existing inventory), which are
// overwhelmingly already-known pages; a page with no inventory row yet
// simply gets no hash recorded this run rather than a synthetic
// discovered_via being invented to satisfy the NOT NULL constraint.
export async function updatePageContentHash(siteId, page, contentHash) {
  await query(
    'UPDATE page_inventory SET content_hash = $1 WHERE site_id = $2 AND page = $3',
    [contentHash, siteId, page]
  );
}

const CONTENT_HASH_CHUNK_SIZE = 25;
export async function updatePageContentHashBatch(siteId, hashByPage) {
  const entries = [...hashByPage.entries()];
  for (let i = 0; i < entries.length; i += CONTENT_HASH_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CONTENT_HASH_CHUNK_SIZE);
    await Promise.all(chunk.map(([page, hash]) => updatePageContentHash(siteId, page, hash)));
  }
}

// Real, accumulated site-wide coverage (not just today's rotation batch) —
// same "merge today's fresh batch with everything already known" shape as
// store/technical-seo-checks.js's listTitlesForSite, applied to content
// hashes instead of titles.
export async function listContentHashesForSite(siteId) {
  const { rows } = await query(
    'SELECT page, content_hash FROM page_inventory WHERE site_id = $1 AND content_hash IS NOT NULL',
    [siteId]
  );
  return rows;
}

// Real, live sibling pages sharing a dead URL's own path prefix — the single
// signal dead-link-intent.js uses to decide whether a missing page can be
// created at all. "Can we create /resources/foo?" is answered by "does this
// site already have other real /resources/* pages to copy the structure of?",
// never by guessing. Pages known to be 4xx/5xx or orphaned are excluded, so a
// prefix whose only other members are themselves broken can't vouch for it.
//
// prefix is URL-derived, so its LIKE metacharacters are escaped — an
// unescaped '_' matches any character and would silently pull in unrelated
// paths (and '%' would match everything under the origin).
export async function listSiblingPages(siteId, prefix, { limit = 25 } = {}) {
  const escaped = prefix.replace(/([\\%_])/g, '\\$1');
  const { rows } = await query(
    `SELECT page FROM page_inventory
      WHERE site_id = $1
        AND page LIKE $2 ESCAPE '\\'
        AND page <> $3
        AND orphaned = false
        AND (http_status IS NULL OR http_status < 400)
      ORDER BY last_seen_at DESC
      LIMIT $4`,
    [siteId, `${escaped}%`, prefix, limit]
  );
  return rows.map((r) => r.page);
}

// Removes specific rows outright (unlike markOrphanedPages, which only
// flags) — used only for page_inventory rows a deterministic check has
// confirmed never belonged to this site at all (see
// server/scripts/purge-spam-page-inventory.js), never for a page that's
// merely unreachable by the current crawl.
const DELETE_CHUNK_SIZE = 100;
export async function deletePageInventoryRows(siteId, pages) {
  let deleted = 0;
  for (let i = 0; i < pages.length; i += DELETE_CHUNK_SIZE) {
    const chunk = pages.slice(i, i + DELETE_CHUNK_SIZE);
    const { rowCount } = await query(
      'DELETE FROM page_inventory WHERE site_id = $1 AND page = ANY($2)',
      [siteId, chunk]
    );
    deleted += rowCount;
  }
  return deleted;
}

export async function listPageInventory(siteId, { limit = 500 } = {}) {
  const { rows } = await query(
    'SELECT page, discovered_via, orphaned, first_seen_at, last_seen_at FROM page_inventory WHERE site_id = $1 ORDER BY last_seen_at DESC LIMIT $2',
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

// ---- Self-cleaning inventory ----------------------------------------------
// page_inventory is a ledger of "every real page we know about". Pages found
// via GSC or a crawl can stop being real (a prior owner's spam URLs, a page
// since redirected or removed, ?param duplicates). Left in, every agent keeps
// scoring them and raising alerts about pages that aren't the site's. This
// prunes ONLY ledger rows — it never touches the site, its repo, or any
// recommendation — and only on positive evidence, never on a guess.
const GONE_STATUSES = new Set([301, 302, 307, 308, 404, 410]);
export const MAX_PRUNE_PROBES = 100;

// Pure decision. A row is pruned only when it is NOT in the live sitemap
// (a sitemap page that is broken is a real problem to report, not to hide)
// AND is provably not a canonical page: a parameter duplicate, a non-https
// variant, or a URL that live-fetches as redirected/not-found/gone.
// status === null (network error / timeout) or any 2xx/5xx keeps the row.
export function shouldPruneInventoryRow({ page, inSitemap, status }) {
  if (inSitemap) return false;
  if (String(page).includes('?')) return true;
  if (/^http:\/\//i.test(page)) return true;
  return status != null && GONE_STATUSES.has(status);
}

async function defaultProbe(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return null;
  }
}

// `sitemapUrls` must be a real, non-empty fetch result — with no sitemap to
// compare against, "not in the sitemap" means nothing, so prune nothing.
export async function pruneStaleInventory(siteId, sitemapUrls, { probe = defaultProbe, maxProbes = MAX_PRUNE_PROBES } = {}) {
  if (!sitemapUrls?.length) return { pruned: [], skipped: 'no-sitemap' };
  const normalize = (u) => u.replace(/\/+$/, '');
  const inSitemap = new Set(sitemapUrls.map(normalize));
  const { rows } = await query('SELECT id, page FROM page_inventory WHERE site_id = $1', [siteId]);

  const toDelete = [];
  let probes = 0;
  for (const row of rows) {
    const listed = inSitemap.has(normalize(row.page));
    let status = null;
    const needsProbe = !listed && !String(row.page).includes('?') && !/^http:\/\//i.test(row.page);
    if (needsProbe && probes < maxProbes) { probes += 1; status = await probe(row.page); }
    if (shouldPruneInventoryRow({ page: row.page, inSitemap: listed, status })) toDelete.push(row);
  }
  if (toDelete.length) {
    await query('DELETE FROM page_inventory WHERE site_id = $1 AND id = ANY($2::int[])', [siteId, toDelete.map((r) => r.id)]);
  }
  return { pruned: toDelete.map((r) => r.page) };
}
