import { listAgentMeta } from '../registry.js';
import { getLatestAgentRuns } from '../../store/agent-runs.js';

// Meta joined with each agent's real latest persisted run for one site —
// shared by GET /api/agents/status (server/routes/agents.js) and the MCP
// get_agent_status tool, so the two surfaces can never drift apart. Never a
// fabricated/simulated "running" state, only what's actually in agent_runs.
export async function getAgentStatusList(siteId) {
  const meta = await listAgentMeta();
  const rows = await getLatestAgentRuns(siteId, meta.map((m) => m.id));
  const byId = new Map(rows.map((r) => [r.agent_id, r]));
  return meta.map((m) => {
    const row = byId.get(m.id);
    return {
      ...m,
      lastRunStatus: row?.status || null,
      lastRunAt: row?.created_at || null,
      lastRunFindings: Array.isArray(row?.facts?.findings) ? row.facts.findings.length : null,
    };
  });
}
