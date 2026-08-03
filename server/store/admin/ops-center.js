import { query } from '../../db.js';

// Platform-wide (cross-tenant) agent_runs aggregates for the AI Operations
// Center — same append-only table and same "existing-data rollups only, no
// new instrumentation" discipline as server/store/admin/system-health.js,
// just aggregated across every site instead of one. Every value here is a
// real persisted row; nothing is synthesized to make the dashboard look
// busier than the platform actually is.

// Most recent run per agent, across ALL sites — unlike getLatestAgentRuns
// (server/store/agent-runs.js), which is scoped to one site for the Action
// Center's recommendation list, this answers "when did each agent last run
// for anyone" for the platform-wide Agent Taskforce grid.
export async function getPlatformAgentLatestRuns(agentIds) {
  const { rows } = await query(
    `SELECT DISTINCT ON (agent_id) agent_id, site_id, status, took_ms, created_at
       FROM agent_runs
      WHERE agent_id = ANY($1)
      ORDER BY agent_id, created_at DESC`,
    [agentIds]
  );
  return rows;
}

// Recent runs across every site, newest first, joined to the site name —
// the Execution Log panel. Bounded by `limit`, same as the per-site
// getRecentActivity, just without a site_id filter.
export async function getPlatformExecutionLog(limit = 30) {
  const { rows } = await query(
    `SELECT ar.site_id, s.name AS site_name, ar.agent_id, ar.status, ar.took_ms, ar.created_at
       FROM agent_runs ar
       JOIN sites s ON s.id = ar.site_id
      ORDER BY ar.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// Today's real counts across every site — the deliberately literal,
// deterministic "technical" executive summary (agents completed/failed,
// drafts created) rather than an LLM narrative, since these are exact
// counts, not a synthesis that benefits from a model's phrasing.
export async function getPlatformTodayCounts() {
  const [runRows, draftRows] = await Promise.all([
    query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'ok')::int AS completed,
          COUNT(*) FILTER (WHERE status != 'ok')::int AS warnings
         FROM agent_runs
        WHERE created_at >= CURRENT_DATE`
    ),
    query(`SELECT COUNT(*)::int AS count FROM drafts WHERE created_at >= CURRENT_DATE`),
  ]);
  return {
    agentsCompleted: runRows.rows[0]?.completed || 0,
    warnings: runRows.rows[0]?.warnings || 0,
    recommendationsPublished: draftRows.rows[0]?.count || 0,
  };
}
