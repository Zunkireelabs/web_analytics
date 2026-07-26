import { query } from '../../db.js';

// Lives under server/store/admin/ alongside this design's other cross-
// tenant aggregates (PLATFORM-ADMIN-DESIGN.md §F.8, §K Phase 6) — a plain
// GROUP BY over the existing append-only agent_runs table, no new
// instrumentation. Scoped to a lookback window, not "since forever," since
// this backs a live status view, not a historical report.
export async function getRecentAgentRunFailureCounts(hours = 24) {
  const { rows } = await query(
    `SELECT site_id, agent_id, COUNT(*)::int AS failure_count, MAX(created_at) AS last_failure_at
       FROM agent_runs
      WHERE status != 'ok' AND created_at >= now() - ($1 || ' hours')::interval
      GROUP BY site_id, agent_id
      ORDER BY failure_count DESC`,
    [hours]
  );
  return rows;
}
