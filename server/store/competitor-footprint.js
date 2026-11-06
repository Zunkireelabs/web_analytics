import { query } from '../db.js';

// Persistence for competitor footprint snapshots (migration 233). Every function takes the siteId and puts it in the
// WHERE clause: nothing here can read or write another project's competitor research.

// One run's keywords for one competitor, all sharing the same captured_at so a snapshot is a single comparable set
// (the same reason upsertCompetitorProfile takes one runAt for a whole run). Written in one statement rather than a
// loop: a footprint is a few hundred rows and a per-row round trip would dominate the run.
export async function saveCompetitorKeywords(siteId, competitorDomain, keywords, { capturedAt = new Date(), providerCostId = null } = {}) {
  if (!keywords.length) return 0;
  const values = [];
  const params = [siteId, competitorDomain, capturedAt, providerCostId];
  let p = params.length;
  for (const k of keywords) {
    values.push(`($1, $2, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $3, $4)`);
    params.push(
      k.keyword, k.locationCode, k.languageCode ?? null, k.position ?? null, k.rankingUrl ?? null,
      k.searchVolume ?? null, k.keywordDifficulty ?? null, k.cpc ?? null, k.searchIntent ?? null, k.estimatedTraffic ?? null
    );
  }
  const { rowCount } = await query(
    `INSERT INTO competitor_keyword_snapshots
       (site_id, competitor_domain, keyword, location_code, language_code, position, ranking_url,
        search_volume, keyword_difficulty, cpc, search_intent, estimated_traffic, captured_at, provider_cost_id)
     VALUES ${values.join(', ')}
     ON CONFLICT (site_id, competitor_domain, keyword, location_code, captured_at) DO NOTHING`,
    params
  );
  return rowCount;
}

export async function saveCompetitorPages(siteId, competitorDomain, pages, { locationCode, capturedAt = new Date(), providerCostId = null } = {}) {
  if (!pages.length) return 0;
  const values = [];
  const params = [siteId, competitorDomain, locationCode, capturedAt, providerCostId];
  let p = params.length;
  for (const page of pages) {
    values.push(`($1, $2, $${++p}, $3, $${++p}, $${++p}, $${++p}::jsonb, $4, $5)`);
    params.push(page.url, page.estimatedTraffic ?? null, page.keywordCount ?? null, JSON.stringify(page.topKeywords || []));
  }
  const { rowCount } = await query(
    `INSERT INTO competitor_page_snapshots
       (site_id, competitor_domain, url, location_code, estimated_traffic, keyword_count, top_keywords, captured_at, provider_cost_id)
     VALUES ${values.join(', ')}
     ON CONFLICT (site_id, competitor_domain, url, location_code, captured_at) DO NOTHING`,
    params
  );
  return rowCount;
}

export async function recordFootprintRun(siteId, competitorDomain, { status, keywordsStored = 0, pagesStored = 0, detail = null, collectedAt = new Date() }) {
  const { rows } = await query(
    `INSERT INTO competitor_footprint_runs (site_id, competitor_domain, collected_at, keywords_stored, pages_stored, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, competitor_domain) DO UPDATE SET
       collected_at = EXCLUDED.collected_at, keywords_stored = EXCLUDED.keywords_stored,
       pages_stored = EXCLUDED.pages_stored, status = EXCLUDED.status, detail = EXCLUDED.detail
     RETURNING site_id, competitor_domain, collected_at, status`,
    [siteId, competitorDomain, collectedAt, keywordsStored, pagesStored, status, detail ? String(detail).slice(0, 500) : null]
  );
  return rows[0];
}

// Competitors whose footprint is older than `maxAgeDays`, or never collected — the list a run is allowed to pay for.
// A failed or refused previous attempt counts as "not collected", so a transient outage does not lock a competitor out
// until the freshness window expires.
export async function listCompetitorsNeedingFootprint(siteId, { maxAgeDays = 30, limit = 5 } = {}) {
  const { rows } = await query(
    `SELECT p.domain, p.relevance_score::float AS relevance_score, r.collected_at, r.status AS last_status
       FROM competitor_profiles p
       LEFT JOIN competitor_footprint_runs r ON r.site_id = p.site_id AND r.competitor_domain = p.domain
      WHERE p.site_id = $1 AND p.kind = 'business' AND p.excluded_reason IS NULL
        AND (r.collected_at IS NULL
             OR r.status <> 'ok'
             OR r.collected_at < now() - ($2::int * interval '1 day'))
      ORDER BY p.relevance_score DESC NULLS LAST, p.domain
      LIMIT $3`,
    [siteId, Math.min(Math.max(Number(maxAgeDays) || 30, 1), 365), Math.min(Math.max(Number(limit) || 5, 1), 50)]
  );
  return rows;
}

// The most recent snapshot set for one competitor. captured_at equality (not a time window) keeps one run's rows
// together even when two runs land minutes apart.
export async function getLatestFootprint(siteId, competitorDomain, { limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT keyword, location_code, language_code, position, ranking_url, search_volume,
            keyword_difficulty, cpc::float AS cpc, search_intent, estimated_traffic::float AS estimated_traffic, captured_at
       FROM competitor_keyword_snapshots
      WHERE site_id = $1 AND competitor_domain = $2
        AND captured_at = (SELECT MAX(captured_at) FROM competitor_keyword_snapshots WHERE site_id = $1 AND competitor_domain = $2)
      ORDER BY search_volume DESC NULLS LAST, keyword
      LIMIT $3`,
    [siteId, competitorDomain, Math.min(Math.max(Number(limit) || 500, 1), 5000)]
  );
  return rows;
}

// The latest footprint across every business competitor, one row per (keyword, competitor) — the input the opportunity
// engine reads. Restricted to competitors still classified as business, so reclassifying a domain immediately stops
// its keywords driving work without deleting the history that was paid for.
export async function getAllLatestFootprints(siteId, { limit = 2000 } = {}) {
  const { rows } = await query(
    `WITH latest AS (
       SELECT competitor_domain, MAX(captured_at) AS captured_at
         FROM competitor_keyword_snapshots WHERE site_id = $1 GROUP BY competitor_domain
     )
     SELECT s.competitor_domain, s.keyword, s.location_code, s.language_code, s.position, s.ranking_url,
            s.search_volume, s.keyword_difficulty, s.cpc::float AS cpc, s.search_intent,
            s.estimated_traffic::float AS estimated_traffic, s.captured_at
       FROM competitor_keyword_snapshots s
       JOIN latest l ON l.competitor_domain = s.competitor_domain AND l.captured_at = s.captured_at
       JOIN competitor_profiles p ON p.site_id = s.site_id AND p.domain = s.competitor_domain
      WHERE s.site_id = $1 AND p.kind = 'business' AND p.excluded_reason IS NULL
      ORDER BY s.search_volume DESC NULLS LAST, s.keyword
      LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limit) || 2000, 1), 20000)]
  );
  return rows;
}

// What changed for one competitor between its two most recent snapshots: the earliest signal that a market is moving.
// Returns null when there is only one snapshot — nothing to compare is not the same as no change.
export async function getFootprintChange(siteId, competitorDomain) {
  const { rows: stamps } = await query(
    `SELECT DISTINCT captured_at FROM competitor_keyword_snapshots
      WHERE site_id = $1 AND competitor_domain = $2 ORDER BY captured_at DESC LIMIT 2`,
    [siteId, competitorDomain]
  );
  if (stamps.length < 2) return null;
  const [current, previous] = stamps.map((r) => r.captured_at);
  const { rows } = await query(
    `WITH cur AS (SELECT keyword, position FROM competitor_keyword_snapshots WHERE site_id = $1 AND competitor_domain = $2 AND captured_at = $3),
          prev AS (SELECT keyword, position FROM competitor_keyword_snapshots WHERE site_id = $1 AND competitor_domain = $2 AND captured_at = $4)
     SELECT
       (SELECT count(*)::int FROM cur WHERE keyword NOT IN (SELECT keyword FROM prev)) AS gained,
       (SELECT count(*)::int FROM prev WHERE keyword NOT IN (SELECT keyword FROM cur)) AS lost,
       (SELECT count(*)::int FROM cur JOIN prev USING (keyword) WHERE cur.position < prev.position) AS improved,
       (SELECT count(*)::int FROM cur JOIN prev USING (keyword) WHERE cur.position > prev.position) AS declined`,
    [siteId, competitorDomain, current, previous]
  );
  return { current, previous, ...rows[0] };
}

// New keywords in this competitor's latest snapshot that were not in the one before: emerging topics, with their
// measured demand, for the opportunity engine to treat as fresh evidence.
export async function getNewlyGainedKeywords(siteId, competitorDomain, { limit = 50 } = {}) {
  const { rows } = await query(
    `WITH stamps AS (
       SELECT DISTINCT captured_at FROM competitor_keyword_snapshots
        WHERE site_id = $1 AND competitor_domain = $2 ORDER BY captured_at DESC LIMIT 2
     ), cur AS (
       SELECT * FROM competitor_keyword_snapshots
        WHERE site_id = $1 AND competitor_domain = $2
          AND captured_at = (SELECT MAX(captured_at) FROM stamps)
     ), prev AS (
       SELECT keyword FROM competitor_keyword_snapshots
        WHERE site_id = $1 AND competitor_domain = $2
          AND captured_at = (SELECT MIN(captured_at) FROM stamps)
          AND (SELECT count(*) FROM stamps) = 2
     )
     SELECT cur.keyword, cur.position, cur.search_volume, cur.ranking_url, cur.location_code
       FROM cur WHERE cur.keyword NOT IN (SELECT keyword FROM prev)
        AND (SELECT count(*) FROM stamps) = 2
      ORDER BY cur.search_volume DESC NULLS LAST
      LIMIT $3`,
    [siteId, competitorDomain, Math.min(Math.max(Number(limit) || 50, 1), 500)]
  );
  return rows;
}
