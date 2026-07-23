import { listAgentMeta } from '../registry.js';
import {
  getLatestAgentRuns as getLatestAgentRunsRaw,
  getLatestFindings as getLatestFindingsRaw,
} from '../../store/agent-runs.js';

// agent_runs (server/store/agent-runs.js) is append-only, and its readers
// trust whatever was inserted most recently with no reference to whether
// that row's *shape* is still current — see agents/types.js's AgentMeta
// .version doc ("bump when the `facts` shape changes"). When an agent's
// meta.version is bumped, an already-persisted row under an OLDER
// agent_version is a real shape mismatch, not just a stale value — the same
// discontinuity authority.js's SCORING_VERSION already guards against for
// its own dedicated table. This generalizes that comparison to the shared
// agent_runs table, for every agent.
//
// A stale row is dropped entirely — treated the same as "agent never ran"
// (callers already handle that case), not rendered as current data under a
// version mismatch.
async function currentVersions() {
  const metas = await listAgentMeta();
  return new Map(metas.map((m) => [m.id, m.version]));
}

function isFresh(agentVersion, currentVersion) {
  return currentVersion == null || agentVersion >= currentVersion; // unknown/removed agent: fail open, don't hide it
}

export async function getLatestAgentRuns(siteId, agentIds) {
  const [runs, versions] = await Promise.all([getLatestAgentRunsRaw(siteId, agentIds), currentVersions()]);
  return runs.filter((r) => isFresh(r.agent_version, versions.get(r.agent_id)));
}

export async function getLatestFindings(siteId, agentIds) {
  const [runs, versions] = await Promise.all([getLatestFindingsRaw(siteId, agentIds), currentVersions()]);
  return runs.filter((r) => isFresh(r.agentVersion, versions.get(r.agentId)));
}
