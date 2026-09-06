import { query } from '../db.js';

// Best-effort: a logging write failing must never take down the shipping run
// it's observing (same swallow-and-log convention as design-integrity-verdicts.js).
export async function recordAutoRemediationRun(siteId, {
  startedAt, finishedAt = new Date(),
  attempted = 0, shipped = 0, failed = 0, refused = 0, skipped = 0, quarantined = 0,
  spentToday = null, dailyLimit = null, stoppedReason = null, prUrl = null, selection = null,
}) {
  try {
    await query(
      `INSERT INTO auto_remediation_runs
        (site_id, started_at, finished_at, attempted, shipped, failed, refused, skipped, quarantined, spent_today, daily_limit, stopped_reason, pr_url, selection)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [siteId, startedAt, finishedAt, attempted, shipped, failed, refused, skipped, quarantined, spentToday, dailyLimit, stoppedReason, prUrl, selection ? JSON.stringify(selection) : null]
    );
  } catch (err) {
    console.error('[auto-remediation-runs] failed to record run log:', err.message);
  }
}

export async function listRecentAutoRemediationRuns(siteId, limit = 20) {
  const { rows } = await query(
    `SELECT * FROM auto_remediation_runs WHERE site_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}
