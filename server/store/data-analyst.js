import { query } from '../db.js';

// Reads against data-analyst-agent's own tables (forecast_runs/forecast_points,
// analyst_recommendations, anomalies) — now in this same Neon database since
// the schema merge. client_id there is the same id space as sites.id here by
// convention (no cross-DB FK was ever possible before the merge; see
// data-analyst-agent/app/db/models.py's Client model).

// forecast_runs is append-only per nightly run (one row per metric per run) —
// this always takes the latest 'ok' run per metric_key, never an older
// snapshot. days bounds how far out the returned forecast horizon extends
// (target_period <= today + days), not how far back the run itself was
// generated. dimension_type/dimension_value default to site-level ('site',
// '__site__') — this tool doesn't expose per-device/per-page forecasts.
export async function getForecasts(siteId, metric, days) {
  const { rows } = await query(
    `SELECT fr.metric_key AS metric,
            fp.point_estimate AS predicted_value,
            fp.lower_bound AS confidence_low,
            fp.upper_bound AS confidence_high,
            fr.model AS model_used,
            to_char(fp.target_period, 'YYYY-MM-DD') AS forecast_date
       FROM forecast_runs fr
       JOIN forecast_points fp ON fp.forecast_run_id = fr.id
      WHERE fr.id IN (
              SELECT DISTINCT ON (metric_key) id
                FROM forecast_runs
               WHERE client_id = $1 AND status = 'ok'
                 AND dimension_type = 'site' AND dimension_value = '__site__'
                 AND ($2::text IS NULL OR metric_key = $2)
               ORDER BY metric_key, generated_at DESC
            )
        AND ($3::int IS NULL OR fp.target_period <= CURRENT_DATE + ($3::int * INTERVAL '1 day'))
      ORDER BY fr.metric_key, fp.target_period`,
    [siteId, metric || null, days ?? null]
  );
  return rows;
}

export async function getAnomalyAlerts(siteId, limit = 20) {
  const { rows } = await query(
    `SELECT metric_key, value, method, score, threshold_used, direction, created_at
       FROM anomalies
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function getSiteProfile(siteId) {
  const { rows } = await query(
    `SELECT industry, main_topics_json AS main_topics, site_type, profiled_at
       FROM site_profiles
      WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function getKeywordClusters(siteId, clusterType) {
  const { rows } = await query(
    `SELECT cluster_name, cluster_type, keywords_json, avg_impressions, avg_position, gap_score
       FROM keyword_clusters
      WHERE site_id = $1 AND ($2::text IS NULL OR cluster_type = $2)
      ORDER BY created_at DESC`,
    [siteId, clusterType || null]
  );
  return rows;
}

// MCP-facing status vocabulary (pending_review/approved/rejected) is
// translated to the real column's values (pending_review/accepted/dismissed)
// here — the DB's CHECK constraint (migration 081) only allows the latter.
const GAP_STATUS_TO_DB = { pending_review: 'pending_review', approved: 'accepted', rejected: 'dismissed' };
const GAP_STATUS_FROM_DB = { pending_review: 'pending_review', accepted: 'approved', dismissed: 'rejected' };

export async function getKeywordGaps(siteId, status) {
  const { rows } = await query(
    `SELECT topic, reason, priority, status, created_at
       FROM keyword_gaps
      WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [siteId, status ? GAP_STATUS_TO_DB[status] : null]
  );
  return rows.map((r) => ({ ...r, status: GAP_STATUS_FROM_DB[r.status] }));
}

export async function updateKeywordGapStatus(siteId, gapId, status) {
  const { rows } = await query(
    `UPDATE keyword_gaps SET status = $3
      WHERE site_id = $1 AND id = $2
      RETURNING topic, reason, priority, status, created_at`,
    [siteId, gapId, GAP_STATUS_TO_DB[status]]
  );
  if (!rows[0]) return null;
  return { ...rows[0], status: GAP_STATUS_FROM_DB[rows[0].status] };
}

// Supplementary keyword/AEO narrative — see server/agents/keyword-narrative.js
// and migration 083_keyword_narratives.sql. Append-only per run, same
// "latest row wins" pattern as getKeywordClusters above.
export async function saveKeywordNarrative(siteId, narrative) {
  await query(
    'INSERT INTO keyword_narratives (site_id, narrative) VALUES ($1, $2)',
    [siteId, narrative]
  );
}

export async function getLatestKeywordNarrative(siteId) {
  const { rows } = await query(
    `SELECT narrative, created_at
       FROM keyword_narratives
      WHERE site_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

// Latest forecast_runs status per metric — used only to flag "any forecast
// issues" for the layout suggester (server/routes/keywords.js), not to read
// forecast values (see getForecasts above for that).
export async function getLatestForecastStatuses(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (metric_key) metric_key, status
       FROM forecast_runs
      WHERE client_id = $1
      ORDER BY metric_key, generated_at DESC`,
    [siteId]
  );
  return rows;
}

// AI layout suggestions — see server/routes/keywords.js's GET .../layout and
// migration 084_layout_suggestions.sql. Append-only per run, same "latest
// row wins" pattern as getKeywordClusters/getLatestKeywordNarrative above.
// layout_json stores { layout: [...9 ids], signature: { anomalyCount, gapCount } }
// so the route can decide whether to reuse this row or regenerate, without
// needing extra columns.
export async function getLatestLayoutSuggestion(siteId) {
  const { rows } = await query(
    `SELECT layout_json, reason, generated_at
       FROM layout_suggestions
      WHERE site_id = $1
      ORDER BY generated_at DESC
      LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function saveLayoutSuggestion(siteId, layoutJson, reason) {
  const { rows } = await query(
    `INSERT INTO layout_suggestions (site_id, layout_json, reason)
     VALUES ($1, $2, $3)
     RETURNING layout_json, reason, generated_at`,
    [siteId, JSON.stringify(layoutJson), reason]
  );
  return rows[0];
}
