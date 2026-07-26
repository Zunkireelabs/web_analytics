import { query } from '../db.js';

// Shared read helpers used by both the daily report and the dashboard API.

export async function listSites() {
  const { rows } = await query('SELECT * FROM sites ORDER BY id');
  return rows;
}

export async function getSiteById(id) {
  const { rows } = await query('SELECT * FROM sites WHERE id = $1', [id]);
  return rows[0] || null;
}

// Single-column lookup for the suspension check every authenticated/MCP
// request now runs (PLATFORM-ADMIN-DESIGN.md §D, §I) — deliberately not
// getSiteById's full row, since this runs on every request across all three
// auth lanes and has nothing to do with the rest of the site record. Returns
// null (not 'active') for a site id that no longer exists, so callers that
// compare against 'active' fail closed by default.
export async function getSiteStatus(id) {
  const { rows } = await query('SELECT status FROM sites WHERE id = $1', [id]);
  return rows[0]?.status ?? null;
}

// Combined GSC + GA4 daily series for a site over an inclusive date range.
export async function getDailySeries(siteId, start, end) {
  const { rows } = await query(
    `SELECT
        to_char(d, 'YYYY-MM-DD') AS date,
        g.clicks, g.impressions, g.ctr, g.position,
        a.users, a.new_users, a.sessions, a.engaged_sessions,
        a.avg_engagement_time, a.conversions
     FROM generate_series($2::date, $3::date, '1 day') AS d
     LEFT JOIN gsc_daily g ON g.site_id = $1 AND g.date = d::date
     LEFT JOIN ga4_daily a ON a.site_id = $1 AND a.date = d::date
     ORDER BY d`,
    [siteId, start, end]
  );
  return rows;
}

// One day's combined metrics (or nulls if missing).
export async function getDay(siteId, date) {
  const { rows } = await getDailySeries(siteId, date, date).then((r) => ({ rows: r }));
  return rows[0] || null;
}

export async function getBreakdown(siteId, date, dimType, limit = 10) {
  const { rows } = await query(
    `SELECT dim_value, clicks, impressions, ctr, position
       FROM gsc_breakdown
      WHERE site_id = $1 AND date = $2 AND dim_type = $3
      ORDER BY clicks DESC, impressions DESC
      LIMIT $4`,
    [siteId, date, dimType, limit]
  );
  return rows;
}

// Top queries aggregated over a date range (used by the weekly report).
export async function getRangeTopQueries(siteId, start, end, limit = 5) {
  const { rows } = await query(
    `SELECT dim_value,
            SUM(clicks)      AS clicks,
            SUM(impressions) AS impressions
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = 'query' AND date BETWEEN $2 AND $3
      GROUP BY dim_value
      ORDER BY clicks DESC, impressions DESC
      LIMIT $4`,
    [siteId, start, end, limit]
  );
  return rows;
}

// Channels aggregated over a date range (so low-traffic single days don't look empty).
export async function getChannelsRange(siteId, start, end) {
  const { rows } = await query(
    `SELECT channel, SUM(sessions) AS sessions, SUM(users) AS users
       FROM ga4_channels
      WHERE site_id = $1 AND date BETWEEN $2 AND $3
      GROUP BY channel
      ORDER BY sessions DESC`,
    [siteId, start, end]
  );
  return rows;
}

export async function getChannels(siteId, date) {
  const { rows } = await query(
    `SELECT channel, sessions, users
       FROM ga4_channels
      WHERE site_id = $1 AND date = $2
      ORDER BY sessions DESC`,
    [siteId, date]
  );
  return rows;
}

export async function getNarrative(siteId, date) {
  const { rows } = await query(
    'SELECT narrative, emailed_at, daily_doc_done FROM daily_reports WHERE site_id = $1 AND date = $2',
    [siteId, date]
  );
  return rows[0] || null;
}

// Website Health score as it stood on a given date (or the closest earlier
// day we have one for) — used for the Command Center's trend chip ("+3 this
// week"). Nullable: a site with no snapshot yet simply shows no trend.
export async function getHealthScoreOnOrBefore(siteId, date) {
  const { rows } = await query(
    `SELECT website_health_score, date FROM daily_reports
      WHERE site_id = $1 AND date <= $2 AND website_health_score IS NOT NULL
      ORDER BY date DESC LIMIT 1`,
    [siteId, date]
  );
  return rows[0]?.website_health_score ?? null;
}

// Every real snapshot between two dates, oldest first — the Review Report's
// (agents/lib/review-report.js) health-score trend. Unlike
// getHealthScoreOnOrBefore (one as-of value), this is the real series a
// trend needs; honestly sparse/empty if snapshots haven't accumulated yet.
export async function getHealthScoreSeries(siteId, start, end) {
  const { rows } = await query(
    `SELECT date, website_health_score FROM daily_reports
      WHERE site_id = $1 AND date BETWEEN $2 AND $3 AND website_health_score IS NOT NULL
      ORDER BY date ASC`,
    [siteId, start, end]
  );
  return rows;
}

// Every persisted integration_health row relevant to a site — both rows
// scoped to this site and system-wide rows (site_id IS NULL, e.g. the shared
// Google OAuth connection every site currently uses). Keyed by integration_id
// so the route can join against the registry's meta for anything never
// checked yet (no row = 'unknown', not an error).
export async function getIntegrationHealth(siteId) {
  const { rows } = await query(
    `SELECT integration_id, status, auth_status, last_success_at, last_failure_at,
            last_checked_at, error_message, recovery_action
       FROM integration_health
      WHERE site_id = $1 OR site_id IS NULL
      ORDER BY integration_id`,
    [siteId]
  );
  return rows;
}

// Most recent distinct dates competitor rankings were checked, newest first
// — rankings are fetched weekly (not daily), so "recent vs prior" for the
// competitor-intelligence agent means the last two checked dates, not a
// fixed day offset like every other agent's period comparison.
export async function getCompetitorRankingDates(siteId, limit = 2) {
  const { rows } = await query(
    'SELECT DISTINCT date FROM competitor_rankings WHERE site_id = $1 ORDER BY date DESC LIMIT $2',
    [siteId, limit]
  );
  return rows.map((r) => r.date.toISOString().slice(0, 10));
}

export async function getCompetitorRankingsOn(siteId, date) {
  const { rows } = await query(
    `SELECT query, domain, url, position, is_own_domain
       FROM competitor_rankings WHERE site_id = $1 AND date = $2
      ORDER BY query, position`,
    [siteId, date]
  );
  return rows;
}

// Available data date range for a site.
// `freshest` = newest day with FINAL search data (the best "complete" day to show).
// `earliest` = oldest day we have. `latestVisitor` = newest GA4 day (a bit fresher).
export async function getDataRange(siteId) {
  const { rows } = await query(
    `SELECT
        to_char(min(g.date), 'YYYY-MM-DD') AS earliest,
        to_char(max(g.date), 'YYYY-MM-DD') AS freshest,
        (SELECT to_char(max(date), 'YYYY-MM-DD') FROM ga4_daily WHERE site_id = $1) AS latest_visitor
       FROM gsc_daily g WHERE g.site_id = $1`,
    [siteId]
  );
  return rows[0] || { earliest: null, freshest: null, latest_visitor: null };
}

// GSC breakdown aggregated over a date range (clicks/impressions/ctr/avg_position by dim_value).
export async function getGscBreakdownRange(siteId, start, end, dimType, limit = 10) {
  const { rows } = await query(
    `SELECT dim_value,
            SUM(clicks)      AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) = 0 THEN 0
                 ELSE ROUND(SUM(clicks)::numeric / SUM(impressions), 5) END AS ctr,
            CASE WHEN SUM(impressions) = 0 THEN NULL
                 ELSE ROUND(SUM(position * impressions) / SUM(impressions), 2) END AS avg_position
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = $2 AND date BETWEEN $3 AND $4
      GROUP BY dim_value
      ORDER BY clicks DESC, impressions DESC
      LIMIT $5`,
    [siteId, dimType, start, end, limit]
  );
  return rows;
}

// GA4 breakdown aggregated over a date range (sessions/users by dim_value).
export async function getGa4BreakdownRange(siteId, start, end, dimType, limit = 10) {
  const { rows } = await query(
    `SELECT dim_value,
            SUM(sessions) AS sessions,
            SUM(users)    AS users
       FROM ga4_breakdown
      WHERE site_id = $1 AND dim_type = $2 AND date BETWEEN $3 AND $4
      GROUP BY dim_value
      ORDER BY sessions DESC, users DESC
      LIMIT $5`,
    [siteId, dimType, start, end, limit]
  );
  return rows;
}

// Top landing page per query over a date range — one row per query, picking the
// page with the most clicks. Lets the UI answer "which page did this query land on?"
export async function getTopPagePerQuery(siteId, start, end) {
  const { rows } = await query(
    `SELECT DISTINCT ON (query) query, page, clicks
       FROM (
         SELECT query, page, SUM(clicks) AS clicks
           FROM gsc_query_page
          WHERE site_id = $1 AND date BETWEEN $2 AND $3
          GROUP BY query, page
       ) t
      ORDER BY query, clicks DESC`,
    [siteId, start, end]
  );
  return rows;
}

// Real query cannibalization: queries where 2+ of the site's OWN pages both
// genuinely rank (real position, real impressions) for the same real query
// — getTopPagePerQuery deliberately collapses to one winning page per query
// (DISTINCT ON), which is exactly why this was invisible before. Grouped in
// JS rather than a single SQL query since "2+ real-ranking pages for the
// same query" needs a per-query array, not a flat row set.
export async function getCannibalizedQueries(siteId, start, end, { minImpressions = 5, maxPosition = 20, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT query, page,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            ROUND(SUM(position * impressions) / NULLIF(SUM(impressions), 0), 2) AS avg_position
       FROM gsc_query_page
      WHERE site_id = $1 AND date BETWEEN $2 AND $3
      GROUP BY query, page
     HAVING SUM(impressions) >= $4`,
    [siteId, start, end, minImpressions]
  );

  const byQuery = new Map();
  for (const r of rows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  }

  const conflicts = [];
  for (const [q, pages] of byQuery) {
    // Both/all pages must genuinely rank (real position within maxPosition)
    // — real impression noise from an unranked page shouldn't count as
    // "competing," matching the source guidance this check is modeled on
    // ("similar positions, both in top 20, split clicks").
    const ranking = pages.filter((p) => p.avg_position != null && Number(p.avg_position) <= maxPosition);
    if (ranking.length < 2) continue;
    ranking.sort((a, b) => Number(b.clicks) - Number(a.clicks));
    conflicts.push({ query: q, pages: ranking });
  }

  conflicts.sort((a, b) =>
    b.pages.reduce((s, p) => s + Number(p.clicks), 0) - a.pages.reduce((s, p) => s + Number(p.clicks), 0)
  );
  return conflicts.slice(0, limit);
}

// Top queries driving traffic to a single landing page over a date range —
// the reverse of getTopPagePerQuery, used by the Content Gap Agent to know
// which real query to check a page's content against (e.g. does it signal
// comparison intent).
export async function getQueriesForPage(siteId, start, end, page, limit = 3) {
  const { rows } = await query(
    `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions
       FROM gsc_query_page
      WHERE site_id = $1 AND page = $2 AND date BETWEEN $3 AND $4
      GROUP BY query
      ORDER BY clicks DESC, impressions DESC
      LIMIT $5`,
    [siteId, page, start, end, limit]
  );
  return rows;
}

// Top device+country for each query over a date range — one row per query,
// picking the device/country combo with the most clicks. Lets the UI show
// "mostly mobile · Indonesia" alongside the landing page for that query.
export async function getTopDeviceCountryPerQuery(siteId, start, end) {
  const { rows } = await query(
    `SELECT DISTINCT ON (query) query, device, country, clicks
       FROM (
         SELECT query, device, country, SUM(clicks) AS clicks
           FROM gsc_query_page
          WHERE site_id = $1 AND date BETWEEN $2 AND $3
          GROUP BY query, device, country
       ) t
      ORDER BY query, clicks DESC`,
    [siteId, start, end]
  );
  return rows;
}

// Top movers: change in query clicks, recent week vs the week before.
// Returns gainers (biggest increase) and droppers (biggest decrease).
export async function getTopMovers(siteId, recent, prior, limit = 8) {
  const { rows } = await query(
    `WITH r AS (
        SELECT dim_value, SUM(clicks) clicks FROM gsc_breakdown
         WHERE site_id=$1 AND dim_type='query' AND date BETWEEN $2 AND $3
         GROUP BY dim_value),
      p AS (
        SELECT dim_value, SUM(clicks) clicks FROM gsc_breakdown
         WHERE site_id=$1 AND dim_type='query' AND date BETWEEN $4 AND $5
         GROUP BY dim_value)
     SELECT COALESCE(r.dim_value, p.dim_value) AS query,
            COALESCE(r.clicks,0) AS recent,
            COALESCE(p.clicks,0) AS prior,
            COALESCE(r.clicks,0) - COALESCE(p.clicks,0) AS delta
       FROM r FULL OUTER JOIN p ON r.dim_value = p.dim_value`,
    [siteId, recent.start, recent.end, prior.start, prior.end]
  );
  const moved = rows.filter((x) => Number(x.delta) !== 0);
  const gainers = moved.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
  const droppers = moved.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);
  return { gainers, droppers };
}

// Per-dim_value search performance aggregated over a date range: clicks,
// impressions, an impression-weighted average position, and CTR computed
// from the summed clicks/impressions (not an average of daily CTRs, which
// would over-weight low-traffic days). Used by agents that need real
// position/CTR — unlike getGscBreakdownRange, which only sums clicks/impressions.
export async function getSearchPerformanceRange(siteId, start, end, dimType, limit = 50) {
  const { rows } = await query(
    `SELECT dim_value,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) = 0 THEN 0
                 ELSE ROUND(SUM(clicks)::numeric / SUM(impressions), 5) END AS ctr,
            CASE WHEN SUM(impressions) = 0 THEN NULL
                 ELSE ROUND(SUM(position * impressions) / SUM(impressions), 2) END AS avg_position
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = $2 AND date BETWEEN $3 AND $4
      GROUP BY dim_value
     HAVING SUM(impressions) > 0
      ORDER BY impressions DESC
      LIMIT $5`,
    [siteId, dimType, start, end, limit]
  );
  return rows;
}

// Real impressions for a specific, small list of pages — not a top-N cut.
// getSearchPerformanceRange's `limit` means a page ranked just outside it
// (e.g. #150 on a site with 100+ actively-trafficked pages) is invisible to
// callers that only use the top-N result, which previously led candidate-
// pages.js to treat "not in the top N" as "zero impressions" — false for
// any such page. This targets exactly the pages asked for, so "no row
// returned" here really does mean zero real impressions in this range.
export async function getSearchPerformanceForPages(siteId, start, end, pages) {
  if (!pages?.length) return [];
  const { rows } = await query(
    `SELECT dim_value, SUM(clicks) AS clicks, SUM(impressions) AS impressions
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = 'page' AND date BETWEEN $2 AND $3 AND dim_value = ANY($4)
      GROUP BY dim_value
     HAVING SUM(impressions) > 0`,
    [siteId, start, end, pages]
  );
  return rows;
}

// Top movers for a ga4_breakdown dimension (e.g. 'country'): change in
// sessions, recent period vs an equal-length prior period. Same gainers/
// droppers shape as getTopMovers, but against GA4 visitor data instead of
// GSC query clicks.
export async function getGa4BreakdownDelta(siteId, dimType, recent, prior, limit = 8) {
  const { rows } = await query(
    `WITH r AS (
        SELECT dim_value, SUM(sessions) sessions FROM ga4_breakdown
         WHERE site_id=$1 AND dim_type=$2 AND date BETWEEN $3 AND $4
         GROUP BY dim_value),
      p AS (
        SELECT dim_value, SUM(sessions) sessions FROM ga4_breakdown
         WHERE site_id=$1 AND dim_type=$2 AND date BETWEEN $5 AND $6
         GROUP BY dim_value)
     SELECT COALESCE(r.dim_value, p.dim_value) AS dim_value,
            COALESCE(r.sessions,0) AS recent,
            COALESCE(p.sessions,0) AS prior,
            COALESCE(r.sessions,0) - COALESCE(p.sessions,0) AS delta
       FROM r FULL OUTER JOIN p ON r.dim_value = p.dim_value`,
    [siteId, dimType, recent.start, recent.end, prior.start, prior.end]
  );
  const moved = rows.filter((x) => Number(x.delta) !== 0);
  const gainers = moved.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
  const droppers = moved.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);
  return { gainers, droppers };
}

// The weekly report doc URL for a site, or null if not created yet.
export async function getWeeklyDocUrl(siteId) {
  const { rows } = await query('SELECT weekly_doc_id FROM sites WHERE id = $1', [siteId]);
  const id = rows[0]?.weekly_doc_id;
  return id ? `https://docs.google.com/document/d/${id}/edit` : null;
}

// The daily report doc URL for a site, or null if not created yet.
export async function getDailyDocUrl(siteId) {
  const { rows } = await query('SELECT daily_doc_id FROM sites WHERE id = $1', [siteId]);
  const id = rows[0]?.daily_doc_id;
  return id ? `https://docs.google.com/document/d/${id}/edit` : null;
}

// The monthly report doc URL for a site, or null if not created yet.
export async function getMonthlyDocUrl(siteId) {
  const { rows } = await query('SELECT monthly_doc_id FROM sites WHERE id = $1', [siteId]);
  const id = rows[0]?.monthly_doc_id;
  return id ? `https://docs.google.com/document/d/${id}/edit` : null;
}

// Aggregate totals for any explicit date range — used by week comparison.
// avg_position deliberately has NO COALESCE: 0 is a real (the best possible)
// rank, so coercing "no GSC rows this period" to 0 would fabricate a perfect
// position instead of honestly reporting no data — same rule Overview.jsx's
// position handling already follows. Real NULL flows through to the
// frontend, which already renders it as "—".
export async function getRangeTotals(siteId, start, end) {
  const { rows } = await query(
    `SELECT
        COALESCE(SUM(g.clicks),0)       AS clicks,
        COALESCE(SUM(g.impressions),0)  AS impressions,
        AVG(g.position)                 AS avg_position,
        COALESCE(SUM(a.users),0)        AS users,
        COALESCE(SUM(a.new_users),0)    AS new_users,
        COALESCE(SUM(a.sessions),0)     AS sessions,
        COALESCE(SUM(a.conversions),0)  AS conversions
     FROM generate_series($2::date, $3::date, '1 day') AS d
     LEFT JOIN gsc_daily g ON g.site_id = $1 AND g.date = d::date
     LEFT JOIN ga4_daily a ON a.site_id = $1 AND a.date = d::date`,
    [siteId, start, end]
  );
  return rows[0];
}

// Aggregate totals for a month (YYYY-MM) — used by the comparison view.
export async function getMonthlyTotals(siteId, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const { rows } = await query(
    `SELECT
        COALESCE(SUM(g.clicks),0)       AS clicks,
        COALESCE(SUM(g.impressions),0)  AS impressions,
        AVG(g.position)                 AS avg_position,
        COALESCE(SUM(a.users),0)        AS users,
        COALESCE(SUM(a.new_users),0)    AS new_users,
        COALESCE(SUM(a.sessions),0)     AS sessions,
        COALESCE(SUM(a.conversions),0)  AS conversions
     FROM generate_series($2::date, ($2::date + interval '1 month' - interval '1 day'), '1 day') AS d
     LEFT JOIN gsc_daily g ON g.site_id = $1 AND g.date = d::date
     LEFT JOIN ga4_daily a ON a.site_id = $1 AND a.date = d::date`,
    [siteId, start]
  );
  return rows[0];
}
