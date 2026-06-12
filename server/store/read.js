import { query } from '../db.js';

// Shared read helpers used by both the daily report and the dashboard API.

export async function listSites() {
  const { rows } = await query('SELECT * FROM sites ORDER BY id');
  return rows;
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
    'SELECT narrative, emailed_at FROM daily_reports WHERE site_id = $1 AND date = $2',
    [siteId, date]
  );
  return rows[0] || null;
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

// GSC breakdown aggregated over a date range (clicks/impressions by dim_value).
export async function getGscBreakdownRange(siteId, start, end, dimType, limit = 10) {
  const { rows } = await query(
    `SELECT dim_value,
            SUM(clicks)      AS clicks,
            SUM(impressions) AS impressions
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

// The weekly report doc URL for a site, or null if not created yet.
export async function getWeeklyDocUrl(siteId) {
  const { rows } = await query('SELECT weekly_doc_id FROM sites WHERE id = $1', [siteId]);
  const id = rows[0]?.weekly_doc_id;
  return id ? `https://docs.google.com/document/d/${id}/edit` : null;
}

// Aggregate totals for any explicit date range — used by week comparison.
export async function getRangeTotals(siteId, start, end) {
  const { rows } = await query(
    `SELECT
        COALESCE(SUM(g.clicks),0)       AS clicks,
        COALESCE(SUM(g.impressions),0)  AS impressions,
        COALESCE(AVG(g.position),0)     AS avg_position,
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
        COALESCE(AVG(g.position),0)     AS avg_position,
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
