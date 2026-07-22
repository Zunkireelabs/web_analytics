import { query, pool } from '../db.js';

// growth_targets (migration 047) — planned "here to here" trajectories for
// the Milestones page, kept deliberately separate from that page's real-data
// summaries (server/agents/lib/growth-report.js). Replacing a target never
// overwrites target_value in place: the CTE below flips the current active
// row to 'superseded' and inserts a fresh active row in the same statement,
// so a target change is atomic and history stays queryable.

export async function getActiveGrowthTargets(siteId) {
  const { rows } = await query(
    `SELECT * FROM growth_targets WHERE site_id = $1 AND status = 'active'`,
    [siteId]
  );
  const byMetric = {};
  for (const row of rows) byMetric[row.metric] = row;
  return byMetric;
}

export async function getGrowthTargetHistory(siteId, metric) {
  const { rows } = await query(
    `SELECT * FROM growth_targets WHERE site_id = $1 AND metric = $2 ORDER BY created_at DESC`,
    [siteId, metric]
  );
  return rows;
}

// A single WITH-clause statement (UPDATE ... superseded CTE feeding an
// INSERT) looked atomic but isn't reliably so here: PostgreSQL's
// data-modifying CTEs share the query's start-of-statement snapshot, so the
// INSERT's uniqueness check against the partial index can race the UPDATE
// that's supposed to clear it, throwing a spurious duplicate-key error on
// growth_targets_active_unique. An explicit transaction avoids that.
export async function setGrowthTarget({ siteId, metric, targetValue, targetDate, baselineValue, baselineDate }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE growth_targets SET status = 'superseded' WHERE site_id = $1 AND metric = $2 AND status = 'active'`,
      [siteId, metric]
    );
    const { rows } = await client.query(
      `INSERT INTO growth_targets (site_id, metric, target_value, target_date, baseline_value, baseline_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [siteId, metric, targetValue, targetDate, baselineValue, baselineDate]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
