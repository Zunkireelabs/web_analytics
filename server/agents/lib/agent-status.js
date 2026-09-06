import { listAgentMeta } from '../registry.js';
import { getLatestAgentRuns } from '../../store/agent-runs.js';
import { listDrafts } from '../../store/drafts.js';

// Real 0-100 score for the handful of agents that compute one on their own
// run (authority, ai-visibility). geo-signals doesn't compute a score
// itself — the real GEO score lives on the weekly geo-audit report draft
// (same source GrowthScores.jsx's GEO tile already reads), so it's passed
// in separately. Every other agent has no comparable self-score; returning
// null for them means the UI shows no badge, never a fabricated number.
function scoreForAgent(agentId, row, geoAuditScore) {
  if (agentId === 'authority') return row?.facts?.authorityScore ?? null;
  if (agentId === 'ai-visibility') return row?.facts?.siteScore?.overall ?? null;
  if (agentId === 'geo-signals') return geoAuditScore;
  return null;
}

// Meta joined with each agent's real latest persisted run for one site —
// shared by GET /api/agents/status (server/routes/agents.js) and the MCP
// get_agent_status tool, so the two surfaces can never drift apart. Never a
// fabricated/simulated "running" state, only what's actually in agent_runs.
export async function getAgentStatusList(siteId) {
  const meta = await listAgentMeta();
  const [rows, geoAuditDrafts] = await Promise.all([
    getLatestAgentRuns(siteId, meta.map((m) => m.id)),
    listDrafts(siteId, { actionType: 'geo-audit' }),
  ]);
  const byId = new Map(rows.map((r) => [r.agent_id, r]));
  const geoAuditScore = geoAuditDrafts[0]?.content?.score?.overall ?? null;
  return meta.map((m) => {
    const row = byId.get(m.id);
    return {
      ...m,
      lastRunStatus: row?.status || null,
      lastRunAt: row?.created_at || null,
      lastRunFindings: Array.isArray(row?.facts?.findings) ? row.facts.findings.length : null,
      lastRunScore: scoreForAgent(m.id, row, geoAuditScore),
    };
  });
}
