import { query } from '../db.js';

// Raw "how recent is the newest row" reads for every input the Analyst
// reasons from. Deliberately one small query per source rather than one
// clever UNION: the sources live in two different services' tables with
// different date columns and different meanings of "recent", and a caller
// that needs only one of them should pay for only one.
//
// WHY THIS EXISTS AT ALL — the twelve-day outage. Between 2026-08-23 and
// 2026-09-04 every MCP-dependent collector in data-analyst-agent failed
// nightly (the standalone MCP server on :3003 was not running), so
// metric_observations stopped at 2026-08-23 and page_query_observations at
// 2026-08-21. The forecast, anomaly and insight engines above them kept
// running, kept succeeding, and kept publishing insights stamped with
// today's date — 231 analyst_recommendations rows generated on 2026-09-04
// from observations that had not moved in a fortnight. Nothing in the
// pipeline asked whether its inputs were still alive, because nothing could:
// there was no function to ask with. This is that function.

// Node-side GSC ingest (server/ingest/gsc.js) — page-level.
export async function gscPageDataAsOf(siteId) {
  const { rows } = await query(
    `SELECT MAX(date)::text AS as_of, COUNT(*)::int AS rows_total
       FROM gsc_breakdown WHERE site_id = $1 AND dim_type = 'page'`,
    [siteId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

// Node-side GSC ingest — the query x page combined table, which every
// page/query analysis (decline-detection, growth-opportunities) reads.
export async function gscQueryPageDataAsOf(siteId) {
  const { rows } = await query(
    `SELECT MAX(date)::text AS as_of, COUNT(*)::int AS rows_total
       FROM gsc_query_page WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

export async function gscDailyDataAsOf(siteId) {
  const { rows } = await query(
    `SELECT MAX(date)::text AS as_of, COUNT(*)::int AS rows_total
       FROM gsc_daily WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

// data-analyst-agent's own store. NOTE the column: these tables are keyed by
// client_id (the Python service's Client), which is the same integer as the
// Node site_id for every site onboarded through create-client — the two
// services share one database and one id space. Kept explicit here rather
// than hidden behind a rename so a future divergence is a visible change.
export async function metricObservationsAsOf(clientId) {
  const { rows } = await query(
    `SELECT MAX(period_start)::text AS as_of, COUNT(*)::int AS rows_total
       FROM metric_observations WHERE client_id = $1`,
    [clientId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

export async function pageQueryObservationsAsOf(clientId) {
  const { rows } = await query(
    `SELECT MAX(period_start)::text AS as_of, COUNT(*)::int AS rows_total
       FROM page_query_observations WHERE client_id = $1`,
    [clientId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

// The forecast/anomaly engines' own most recent output. Read as a
// TIMESTAMP (when it ran), unlike the sources above which are read as a DATA
// DATE (what day the data covers) — a forecast run yesterday over data from
// three weeks ago is exactly the failure being detected, and conflating the
// two would hide it.
export async function forecastRunsAsOf(clientId) {
  const { rows } = await query(
    `SELECT MAX(generated_at) AS as_of, COUNT(*)::int AS rows_total
       FROM forecast_runs WHERE client_id = $1 AND status = 'ok'`,
    [clientId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

export async function anomaliesAsOf(clientId) {
  const { rows } = await query(
    `SELECT MAX(period_start)::text AS as_of, COUNT(*)::int AS rows_total
       FROM anomalies WHERE client_id = $1`,
    [clientId]
  );
  return rows[0] || { as_of: null, rows_total: 0 };
}

// The collector chain's own report card: the latest run per collector, with
// its status and (since the _describe fix in run_nightly.py) an error that
// always names itself. This is what turns "the data is old" into "and here
// is which collector stopped, and what it said".
export async function latestCollectorRuns(clientId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (collector_id)
            collector_id, status, error, took_ms, run_date, created_at
       FROM ingestion_runs
      WHERE client_id = $1
      ORDER BY collector_id, created_at DESC`,
    [clientId]
  );
  return rows;
}
