import { getLatestFindings } from './fresh-runs.js';
import { HEALTH_SCORE_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';
import { getImplementedFindingIds } from '../../store/drafts.js';
import { computeHealthScore } from './health-score.js';

// The website health score as of now, computed the way Command Center shows it: every agent's latest saved findings, minus what has
// already been fixed, weighted by category. The nightly job used to compute its own copy from a shorter list of agents and WITHOUT the
// category weights, then write it to the same daily slot Command Center writes, so the stored score (and the "this week" trend built
// from it) depended on which of the two wrote last. Both now call this.
export async function computeCurrentHealthScore(siteId, deps = {}) {
  const d = { getLatestFindings, getImplementedFindingIds, categoryByAgentId, computeHealthScore, ...deps };
  const [runs, implementedFindingIds, catByAgent] = await Promise.all([
    d.getLatestFindings(siteId, HEALTH_SCORE_AGENT_IDS),
    d.getImplementedFindingIds(siteId),
    d.categoryByAgentId(),
  ]);
  const findings = runs.flatMap((r) => r.findings.map((f) => ({ ...f, agentId: r.agentId })));
  return d.computeHealthScore(findings, implementedFindingIds, catByAgent);
}
