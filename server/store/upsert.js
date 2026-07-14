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

export async function saveDailyReportNarrative(siteId, date, narrative) {
  await query(
    'UPDATE sites SET daily_report_narrative = $1, daily_report_narrative_date = $2 WHERE id = $3',
    [narrative, date, siteId]
  );
}

export async function saveWeeklyReportNarrative(siteId, start, end, narrative) {
  await query(
    `UPDATE sites SET weekly_report_narrative = $1,
       weekly_report_narrative_start = $2, weekly_report_narrative_end = $3 WHERE id = $4`,
    [narrative, start, end, siteId]
  );
}

export async function saveMonthlyReportNarrative(siteId, ym, narrative) {
  await query(
    'UPDATE sites SET monthly_report_narrative = $1, monthly_report_narrative_ym = $2 WHERE id = $3',
    [narrative, ym, siteId]
  );
}

// One row per (site, date, query, domain) — see migrations/018 and
// ingest/competitors.js. Re-running the same week overwrites (never
// duplicates), same convention as every other upsert in this file.
export async function saveCompetitorRankings(siteId, rows) {
  for (const r of rows) {
    await query(
      `INSERT INTO competitor_rankings (site_id, date, query, domain, url, position, is_own_domain)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (site_id, date, query, domain) DO UPDATE SET
         url = EXCLUDED.url, position = EXCLUDED.position, is_own_domain = EXCLUDED.is_own_domain`,
      [siteId, r.date, r.query, r.domain, r.url, r.position, r.isOwnDomain]
    );
  }
}

// One row per site per day — called each time the Command Center computes a
// fresh score, so same-day calls just overwrite today's value; the trend
// only changes once the calendar day does.
export async function saveHealthScoreSnapshot(siteId, date, score) {
  await query(
    `INSERT INTO daily_reports (site_id, date, website_health_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, date) DO UPDATE SET website_health_score = EXCLUDED.website_health_score`,
    [siteId, date, score]
  );
}

// Sets the real "day 0" anchor for a client — called exactly once, right
// after the first real baseline agent run completes during onboarding
// (server/routes/clients.js). Idempotent to call again (e.g. a retried
// connect step) — always reflects the most recent real baseline run, never
// backfilled or guessed.
export async function setOnboardingBaseline(siteId, baselineRunId) {
  await query(
    `UPDATE sites SET onboarded_at = now(), baseline_run_id = $2 WHERE id = $1`,
    [siteId, baselineRunId]
  );
}

// One row per (integration, site) — see migrations/020 and
// integrations/registry.js. Called from both the on-demand "Test connection"
// route and job.js's organic per-site failure handling, so there's a single
// place recording status regardless of how the check happened. last_success_at
// / last_failure_at only advance forward (COALESCE keeps the prior value on
// the branch that didn't just happen), so a failing integration keeps its
// last real success timestamp instead of losing it on the next failed check.
export async function recordIntegrationCheck(integrationId, siteId, { ok, authStatus, errorMessage, recoveryAction }) {
  const now = new Date();
  await query(
    `INSERT INTO integration_health
       (integration_id, site_id, status, auth_status, last_success_at, last_failure_at, last_checked_at, error_message, recovery_action, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7)
     ON CONFLICT (integration_id, COALESCE(site_id, -1)) DO UPDATE SET
       status = EXCLUDED.status,
       auth_status = EXCLUDED.auth_status,
       last_success_at = COALESCE(EXCLUDED.last_success_at, integration_health.last_success_at),
       last_failure_at = COALESCE(EXCLUDED.last_failure_at, integration_health.last_failure_at),
       last_checked_at = EXCLUDED.last_checked_at,
       error_message = EXCLUDED.error_message,
       recovery_action = EXCLUDED.recovery_action,
       updated_at = EXCLUDED.updated_at`,
    [
      integrationId, siteId ?? null, ok ? 'ok' : 'error', authStatus ?? null,
      ok ? now : null, ok ? null : now, now, errorMessage ?? null, recoveryAction ?? null,
    ]
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
