import { query } from '../db.js';

// All upserts use ON CONFLICT DO UPDATE keyed on the primary key, so re-running
// the ingest for the same day overwrites with fresh values (never duplicates).

export async function upsertGsc(siteId, { date, totals, queries, pages, devices = [], countries = [], queryPages = [] }) {
  await query(
    `INSERT INTO gsc_daily (site_id, date, clicks, impressions, ctr, position)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, date) DO UPDATE SET
       clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
       ctr = EXCLUDED.ctr, position = EXCLUDED.position`,
    [siteId, date, totals.clicks, totals.impressions, totals.ctr, totals.position]
  );

  // Replace the day's breakdown rows so stale entries don't linger.
  await query('DELETE FROM gsc_breakdown WHERE site_id = $1 AND date = $2', [siteId, date]);

  const rows = [
    ...queries.map((r) => ({ ...r, dim_type: 'query' })),
    ...pages.map((r) => ({ ...r, dim_type: 'page' })),
    ...devices.map((r) => ({ ...r, dim_type: 'device' })),
    ...countries.map((r) => ({ ...r, dim_type: 'country' })),
  ];
  for (const r of rows) {
    await query(
      `INSERT INTO gsc_breakdown (site_id, date, dim_type, dim_value, clicks, impressions, ctr, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (site_id, date, dim_type, dim_value) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position`,
      [siteId, date, r.dim_type, r.dim_value, r.clicks, r.impressions, r.ctr, r.position]
    );
  }

  // Replace the day's query+page rows so stale entries don't linger.
  await query('DELETE FROM gsc_query_page WHERE site_id = $1 AND date = $2', [siteId, date]);
  for (const r of queryPages) {
    await query(
      `INSERT INTO gsc_query_page (site_id, date, query, page, device, country, clicks, impressions, ctr, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (site_id, date, query, page, device, country) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position`,
      [siteId, date, r.query, r.page, r.device, r.country, r.clicks, r.impressions, r.ctr, r.position]
    );
  }
}

export async function upsertGa4(siteId, { date, totals, channels, devices = [], countries = [], cities = [], languages = [] }) {
  await query(
    `INSERT INTO ga4_daily
       (site_id, date, users, new_users, sessions, engaged_sessions, avg_engagement_time, conversions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (site_id, date) DO UPDATE SET
       users = EXCLUDED.users, new_users = EXCLUDED.new_users,
       sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
       avg_engagement_time = EXCLUDED.avg_engagement_time, conversions = EXCLUDED.conversions`,
    [
      siteId, date, totals.users, totals.new_users, totals.sessions,
      totals.engaged_sessions, totals.avg_engagement_time, totals.conversions,
    ]
  );

  await query('DELETE FROM ga4_channels WHERE site_id = $1 AND date = $2', [siteId, date]);
  for (const c of channels) {
    await query(
      `INSERT INTO ga4_channels (site_id, date, channel, sessions, users)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, date, channel) DO UPDATE SET
         sessions = EXCLUDED.sessions, users = EXCLUDED.users`,
      [siteId, date, c.channel, c.sessions, c.users]
    );
  }

  // GA4 device + country + city + language breakdowns → ga4_breakdown (replace the day's rows).
  await query('DELETE FROM ga4_breakdown WHERE site_id = $1 AND date = $2', [siteId, date]);
  const ga4Rows = [
    ...devices.map((r) => ({ ...r, dim_type: 'device' })),
    ...countries.map((r) => ({ ...r, dim_type: 'country' })),
    ...cities.map((r) => ({ ...r, dim_type: 'city' })),
    ...languages.map((r) => ({ ...r, dim_type: 'language' })),
  ];
  for (const r of ga4Rows) {
    await query(
      `INSERT INTO ga4_breakdown (site_id, date, dim_type, dim_value, sessions, users)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_id, date, dim_type, dim_value) DO UPDATE SET
         sessions = EXCLUDED.sessions, users = EXCLUDED.users`,
      [siteId, date, r.dim_type, r.dim_value, r.sessions, r.users]
    );
  }
}

export async function saveNarrative(siteId, date, narrative, emailedAt = null) {
  await query(
    `INSERT INTO daily_reports (site_id, date, narrative, emailed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, date) DO UPDATE SET
       narrative = EXCLUDED.narrative,
       emailed_at = COALESCE(EXCLUDED.emailed_at, daily_reports.emailed_at)`,
    [siteId, date, narrative, emailedAt]
  );
}

export async function markDailyDocDone(siteId, date) {
  await query(
    `INSERT INTO daily_reports (site_id, date, daily_doc_done)
     VALUES ($1, $2, now())
     ON CONFLICT (site_id, date) DO UPDATE SET daily_doc_done = now()`,
    [siteId, date]
  );
}
