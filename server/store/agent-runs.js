import { query } from '../db.js';

// Append-only log for agent_runs — see server/migrations/010_agent_runs.sql
// for why this is insert-only rather than an upsert like daily_reports.

export async function saveAgentRun({ siteId, agentId, agentVersion, input, status, facts, narrative, error, tookMs }) {
  await query(
    `INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, facts, narrative, error, took_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      siteId, agentId, agentVersion,
      JSON.stringify(input ?? {}),
      status,
      facts != null ? JSON.stringify(facts) : null,
      narrative ?? null,
      error ?? null,
      tookMs ?? null,
    ]
  );
}

// The single most recent run per agent, for a given set of agent ids — used
// by the Action Center to build its recommendation list instantly from
// already-persisted data instead of re-running every agent on page load.
export async function getLatestAgentRuns(siteId, agentIds) {
  const { rows } = await query(
    `SELECT DISTINCT ON (agent_id) id, agent_id, agent_version, input, status, facts, narrative, error, took_ms, created_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = ANY($2)
      ORDER BY agent_id, created_at DESC`,
    [siteId, agentIds]
  );
  return rows;
}

export async function getAgentRunHistory(siteId, agentId, limit = 10) {
  const { rows } = await query(
    `SELECT id, agent_id, agent_version, status, facts, narrative, error, took_ms, created_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, agentId, limit]
  );
  return rows;
}
