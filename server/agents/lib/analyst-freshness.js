import {
  gscPageDataAsOf, gscQueryPageDataAsOf, metricObservationsAsOf, pageQueryObservationsAsOf,
  forecastRunsAsOf, anomaliesAsOf, latestCollectorRuns,
} from '../../store/data-freshness.js';

// The guard the twelve-day outage proved does not exist anywhere in the
// pipeline. Between 2026-08-23 and 2026-09-04 metric_observations and
// page_query_observations stopped moving because the standalone MCP server
// was down, and every layer above them — forecast_runs, anomalies, insights,
// analyst_recommendations — kept computing and kept publishing, stamped
// with the run date rather than the data date. A forecasting engine that
// keeps calculating is not the same thing as a forecasting engine that knows
// whether its inputs are still trustworthy; this module is what makes it
// know.
//
// Thresholds are keyed to how each source actually updates, not one flat
// number for everything:
//   - GSC data legitimately lags ~3 days (Google's own backfill window,
//     GSC_LAG_DAYS elsewhere in this codebase) even when nothing is broken,
//     so "stale" for GSC-derived tables starts past that lag, not at it.
//   - metric_observations/page_query_observations are written by the nightly
//     MCP-backed collector chain and should be at most ~1-2 days old on a
//     healthy night.
//   - forecast_runs/anomalies are a TIMESTAMP of when the engine last ran,
//     not a data date — even a healthy engine can go quiet on a quiet
//     weekend, so its own threshold is looser; what actually matters is
//     catching it running against long-stale *inputs*, which the input
//     checks above already do.
const THRESHOLDS_DAYS = {
  gscPage: 5,
  gscQueryPage: 5,
  metricObservations: 3,
  pageQueryObservations: 3,
  forecastRuns: 7,
  anomalies: 7,
};

// GSC's own backfill lag — a page/query row this many days old is expected,
// not stale. Same constant as decline-detection.js's GSC_LAG_DAYS and
// job.js's GSC_LAG_DAYS; not imported from either to avoid a cross-module
// coupling for one integer literal (same convention decline-detection.js
// already documents for its own copy).
const GSC_LAG_DAYS = 3;

function ageDays(asOf, now = new Date()) {
  if (!asOf) return null;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

function sourceStatus(key, asOf, rowsTotal, now) {
  const age = ageDays(asOf, now);
  const threshold = THRESHOLDS_DAYS[key];
  const stale = rowsTotal === 0 || age == null || age > threshold;
  return { source: key, asOf, rowsTotal, ageDays: age, thresholdDays: threshold, stale };
}

/**
 * Reads every input the Analyst reasons from for one site and returns a
 * verdict a caller can act on WITHOUT re-deriving the logic:
 *
 *   fresh    — every source within its threshold. Full-confidence,
 *              autonomous action allowed.
 *   degraded — at least one source stale but not every source dead. Still
 *              usable, but confidence must be reduced and the reason shown.
 *   stale    — the core inputs (GSC page/query data, or the collector's own
 *              observation tables) are stale. No autonomous action should be
 *              taken on a 'stale' verdict; present findings as monitor-only
 *              and say so.
 *
 * `clientId` is the same integer as `siteId` (see data-freshness.js's note)
 * — both are accepted so callers that only have one name for it don't need
 * to remember the alias.
 */
export async function checkAnalystFreshness(siteId, { now = new Date() } = {}) {
  const clientId = siteId;
  const [gscPage, gscQueryPage, metricObs, pageQueryObs, forecasts, anomalyRows, collectorRuns] = await Promise.all([
    gscPageDataAsOf(siteId),
    gscQueryPageDataAsOf(siteId),
    metricObservationsAsOf(clientId),
    pageQueryObservationsAsOf(clientId),
    forecastRunsAsOf(clientId),
    anomaliesAsOf(clientId),
    latestCollectorRuns(clientId).catch(() => []),
  ]);

  const sources = {
    gscPage: sourceStatus('gscPage', gscPage.as_of, gscPage.rows_total, now),
    gscQueryPage: sourceStatus('gscQueryPage', gscQueryPage.as_of, gscQueryPage.rows_total, now),
    metricObservations: sourceStatus('metricObservations', metricObs.as_of, metricObs.rows_total, now),
    pageQueryObservations: sourceStatus('pageQueryObservations', pageQueryObs.as_of, pageQueryObs.rows_total, now),
    forecastRuns: sourceStatus('forecastRuns', forecasts.as_of, forecasts.rows_total, now),
    anomalies: sourceStatus('anomalies', anomalyRows.as_of, anomalyRows.rows_total, now),
  };

  // The core inputs — if either of these is stale, nothing downstream can
  // honestly be called current, no matter how recently the forecast engine
  // itself last ran. This is precisely the outage's failure mode: forecast
  // rows and insight rows were freshly stamped while their real inputs had
  // been dead for twelve days.
  const coreStale = sources.metricObservations.stale || sources.pageQueryObservations.stale
    || sources.gscQueryPage.stale;
  const anyStale = Object.values(sources).some((s) => s.stale);

  // Named failing collectors, when we have a report card for them, so the
  // verdict can say WHICH input died rather than just that something did —
  // the exact gap that let the outage run twelve days unnoticed (see
  // run_nightly.py's _describe comment).
  const failingCollectors = (collectorRuns || [])
    .filter((r) => r.status === 'error' || r.status === 'insufficient-data')
    .map((r) => ({ collectorId: r.collector_id, status: r.status, error: r.error, lastRunAt: r.created_at }));

  const verdict = coreStale ? 'stale' : (anyStale ? 'degraded' : 'fresh');

  // A confidence MULTIPLIER, not a floor — applied by the caller against
  // whatever confidence the fusion computed, so "the inputs are old" and
  // "the evidence is weak" compose instead of one silently overriding the
  // other. 0 on 'stale' is deliberate: it is not a smaller number, it is a
  // hard veto on presenting the result as current (see gate() below).
  const confidenceMultiplier = verdict === 'fresh' ? 1 : (verdict === 'degraded' ? 0.5 : 0);

  return { siteId, verdict, confidenceMultiplier, sources, failingCollectors, checkedAt: now.toISOString() };
}

/**
 * The enforcement point every autonomous consumer of Analyst output must
 * call before treating a conclusion as current. Never throws — a stale
 * pipeline must not crash the run, it must downgrade it, which is the whole
 * lesson of the outage: a hard failure would at least have been noticed,
 * silent confident output was what actually caused the twelve-day blind
 * spot.
 *
 * Returns { allowAutonomous, presentation, reason }:
 *   allowAutonomous — false on 'stale'. Callers must not auto-ship, and
 *                     should route the item to a human-reviewed / manual
 *                     tier instead of dropping it entirely.
 *   presentation    — 'current' | 'degraded' | 'stale-do-not-trust', the
 *                     label a UI or notification should show next to the
 *                     finding so a forecast never LOOKS current when it
 *                     isn't.
 */
export function gate(freshness) {
  if (freshness.verdict === 'stale') {
    const named = freshness.failingCollectors.map((c) => c.collectorId).join(', ');
    return {
      allowAutonomous: false,
      presentation: 'stale-do-not-trust',
      reason: named
        ? `Core analyst inputs are stale; failing collector(s): ${named}.`
        : 'Core analyst inputs (GSC query/page data or the nightly observation tables) are stale.',
    };
  }
  if (freshness.verdict === 'degraded') {
    return {
      allowAutonomous: true,
      presentation: 'degraded',
      reason: 'One or more analyst inputs are older than expected; confidence has been reduced accordingly.',
    };
  }
  return { allowAutonomous: true, presentation: 'current', reason: null };
}
