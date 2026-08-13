import { query } from '../db.js';

// Persistence for fix_impact (migration 104) — "what did this merged fix
// actually do to real Search Console numbers", as opposed to
// fix-verifications.js's "is the issue genuinely gone from the live page".
// Same append-then-resolve shape as that module: a pending row is created the
// moment a PR merges, and a later sweep fills in the measurement.

// How long after the merge to measure. 28 days of post-merge data is the
// shortest window in which a search-performance change is worth reading at all,
// and GSC finalizes with a real ~3-day lag (see job.js's GSC_LAG_DAYS), so the
// data for day 28 does not exist until day 31. Measuring earlier would not be
// "an early read", it would be reading a window the database has not been given
// yet — and reporting a fabricated-looking zero.
const WINDOW_DAYS = Number(process.env.FIX_IMPACT_WINDOW_DAYS) || 28;
const GSC_LAG_DAYS = 3;
export const IMPACT_DELAY_DAYS = WINDOW_DAYS + GSC_LAG_DAYS;
export { WINDOW_DAYS as IMPACT_WINDOW_DAYS };

// Site-level fixes have no single page whose metrics could be attributed to
// them — llms-txt, robots-fix and sitemap change how the whole site is
// crawled/understood. Recorded as 'unmeasurable' up front rather than being
// attributed to the homepage, which would be an invented attribution.
const SITE_LEVEL_GENERATOR_IDS = new Set([
  'llms-txt', 'robots-fix', 'sitemap', 'security-headers', 'html-lang',
  'cookie-policy', 'privacy-policy', 'terms-of-service',
]);

export function isMeasurableFix(generatorId, pageUrl) {
  return !SITE_LEVEL_GENERATOR_IDS.has(generatorId) && !!pageUrl;
}

// Idempotent on draft_id (unique index): a draft that somehow merges twice
// updates its pending row rather than accumulating duplicate measurements of
// the same window. Never overwrites an already-completed measurement.
export async function scheduleImpactMeasurement(siteId, { draftId, pageUrl, generatorId, mergedAt }) {
  const measurable = isMeasurableFix(generatorId, pageUrl);
  const { rows } = await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), COALESCE($5, now()) + ($6 * interval '1 day'), $7)
     ON CONFLICT (draft_id) DO UPDATE
       SET merged_at = EXCLUDED.merged_at,
           measure_after = EXCLUDED.measure_after,
           page_url = EXCLUDED.page_url
     WHERE fix_impact.status = 'pending'
     RETURNING *`,
    [siteId, draftId, pageUrl || null, generatorId, mergedAt || null, IMPACT_DELAY_DAYS,
      measurable ? 'pending' : 'unmeasurable']
  );
  return rows[0] || null;
}

export async function getDueImpactMeasurements(limit = 50) {
  const { rows } = await query(
    `SELECT * FROM fix_impact
      WHERE status = 'pending' AND measure_after <= now()
      ORDER BY measure_after
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function recordImpactOutcome(id, { status, beforeWindow, afterWindow, delta }) {
  const { rows } = await query(
    `UPDATE fix_impact
        SET status = $2, measured_at = now(),
            before_window = $3, after_window = $4, delta = $5
      WHERE id = $1
      RETURNING *`,
    [id, status,
      beforeWindow ? JSON.stringify(beforeWindow) : null,
      afterWindow ? JSON.stringify(afterWindow) : null,
      delta ? JSON.stringify(delta) : null]
  );
  return rows[0] || null;
}

// Real Search Console totals for ONE page over a date range. gsc_breakdown's
// per-page rows are what the dashboard already reads; this aggregates them the
// same way getSearchPerformanceRange does (impression-weighted position, not a
// plain average of daily positions, which would over-weight low-traffic days).
//
// Returns null when the page has no impressions in the window at all — an
// honest "no data", distinct from a real zero, so the caller can report
// insufficient-data rather than a fabricated 0% change.
export async function getPageSearchTotals(siteId, page, start, end) {
  const { rows } = await query(
    `SELECT SUM(clicks)::int AS clicks,
            SUM(impressions)::int AS impressions,
            CASE WHEN SUM(impressions) = 0 THEN NULL
                 ELSE ROUND(SUM(clicks)::numeric / SUM(impressions), 5) END AS ctr,
            CASE WHEN SUM(impressions) = 0 THEN NULL
                 ELSE ROUND(SUM(position * impressions) / SUM(impressions), 2) END AS avg_position
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = 'page' AND dim_value = $2
        AND date BETWEEN $3 AND $4`,
    [siteId, page, start, end]
  );
  const r = rows[0];
  if (!r || !r.impressions) return null;
  return {
    clicks: r.clicks, impressions: r.impressions,
    ctr: r.ctr == null ? null : Number(r.ctr),
    avgPosition: r.avg_position == null ? null : Number(r.avg_position),
    start, end,
  };
}

// Measured outcomes for reporting. Only rows that actually produced a
// measurement — 'pending'/'unmeasurable' rows would pad a report with entries
// carrying no information.
export async function listMeasuredImpact(siteId, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM fix_impact
      WHERE site_id = $1 AND status = 'measured'
      ORDER BY measured_at DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

// Aggregate measured outcomes per generator — the shape a future calibration
// step needs to ask "does this generator's expectedImpact resemble what
// actually happens?". Deliberately just the real numbers; nothing here decides
// what to do with them yet.
export async function impactByGenerator(siteId) {
  const { rows } = await query(
    `SELECT generator_id,
            count(*)::int AS measured,
            SUM((delta->>'impressions')::numeric)::int AS impressions_delta,
            SUM((delta->>'clicks')::numeric)::int AS clicks_delta,
            ROUND(AVG((delta->>'avgPosition')::numeric), 2) AS avg_position_delta
       FROM fix_impact
      WHERE site_id = $1 AND status = 'measured' AND delta IS NOT NULL
      GROUP BY generator_id
      ORDER BY measured DESC`,
    [siteId]
  );
  return rows;
}
