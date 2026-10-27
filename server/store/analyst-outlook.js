import { query } from '../db.js';

// Read helpers for the Analyst page's Outlook and Fixes subpages. All scoped by site_id.

// Recent drafts with the page each is aimed at (input.page or content.page).
export async function listRecentDraftsWithPage(siteId, days = 60, limit = 400) {
  const { rows } = await query(
    `SELECT id, action_type, status, created_at, implemented_at,
            COALESCE(input->>'page', content->>'page') AS page
       FROM drafts
      WHERE site_id = $1 AND created_at >= now() - ($2 || ' days')::interval
      ORDER BY created_at DESC LIMIT $3`,
    [siteId, String(days), limit]
  );
  return rows.map((r) => ({ id: r.id, actionType: r.action_type, status: r.status, createdAt: r.created_at, implementedAt: r.implemented_at, page: r.page }));
}

// Pages that have an open recommendation the agent will work on.
export async function listOpenRecommendationPages(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT page FROM recommendations WHERE site_id = $1 AND status = 'open' AND page IS NOT NULL AND page <> ''`,
    [siteId]
  );
  return rows.map((r) => r.page);
}

export async function listMeasuredDraftIds(siteId) {
  const { rows } = await query(`SELECT draft_id FROM fix_impact WHERE site_id = $1 AND status = 'measured'`, [siteId]);
  return rows.map((r) => r.draft_id);
}

// Queries whose clicks grew most (last 28 days vs the 28 before), with enough volume to mean something.
export async function listRisingQueries(siteId, { minClicks = 10, limit = 3 } = {}) {
  const { rows } = await query(
    `WITH recent AS (
       SELECT query, SUM(clicks) AS c FROM gsc_query_page
        WHERE site_id = $1 AND date >= current_date - 28 GROUP BY query
     ), prior AS (
       SELECT query, SUM(clicks) AS c FROM gsc_query_page
        WHERE site_id = $1 AND date >= current_date - 56 AND date < current_date - 28 GROUP BY query
     )
     SELECT r.query, r.c AS recent, COALESCE(p.c, 0) AS prior
       FROM recent r LEFT JOIN prior p USING (query)
      WHERE r.c >= $2 AND COALESCE(p.c, 0) >= $2 / 2 AND r.c > p.c * 1.15
      ORDER BY (r.c - COALESCE(p.c, 0)) DESC LIMIT $3`,
    [siteId, minClicks, limit]
  );
  return rows.map((r) => ({ query: r.query, pctChange: Math.round(((Number(r.recent) - Number(r.prior)) / Math.max(Number(r.prior), 1)) * 100) }));
}

// Platform-wide: how each kind of fix has performed once measured, across every project. Counts and
// averages only (no site, page or query), and a kind needs at least `minTimes` measurements to appear.
export async function impactByGeneratorAllSites(minTimes = 3) {
  const { rows } = await query(
    `SELECT generator_id, count(*)::int AS times,
            ROUND(AVG((delta->>'clicks')::numeric), 1) AS avg_clicks_delta,
            ROUND(100.0 * AVG(CASE WHEN (delta->>'clicks')::numeric > 0 THEN 1 ELSE 0 END), 0) AS pct_positive
       FROM fix_impact
      WHERE status = 'measured' AND delta IS NOT NULL AND delta ? 'clicks'
      GROUP BY generator_id
     HAVING count(*) >= $1
      ORDER BY count(*) DESC`,
    [minTimes]
  );
  return rows.map((r) => ({ generatorId: r.generator_id, times: r.times, avgClicksDelta: Number(r.avg_clicks_delta), pctPositive: Number(r.pct_positive) }));
}
