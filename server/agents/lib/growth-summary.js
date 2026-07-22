import { getDailySeries } from '../../store/read.js';
import { getLatestFindings } from '../../store/agent-runs.js';
import { getImplementedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { projectHealthScore, projectClicks, projectImpressions } from './growth-projection.js';

// Staff-only "every client at a glance" summary (server/routes/clients.js's
// GET /internal/clients/growth-summary) — deliberately lighter than
// buildGrowthReport (server/agents/lib/growth-report.js), which runs 9-10
// queries per site pulling full historical series this view doesn't need.
// Only 3 queries per site: real open findings (feeds projectHealthScore),
// implemented-finding ids, and a real trailing-14-day daily series (feeds
// both projectClicks' 7-day click baseline and projectImpressions' 14-day
// trend check). Same projection functions as the single-site Milestones
// page, not reimplemented.
export async function buildGrowthSummary(site) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const [findingRuns, implementedFindingIds, catByAgent, recentDaily] = await Promise.all([
    getLatestFindings(site.id, RECOMMENDATION_AGENT_IDS),
    getImplementedFindingIds(site.id),
    categoryByAgentId(),
    getDailySeries(site.id, fourteenDaysAgo.toISOString().slice(0, 10), today),
  ]);

  const allFindings = findingRuns.flatMap((r) => r.findings.map((f) => ({ ...f, agentId: r.agentId })));
  const baselineWeeklyClicks = recentDaily.slice(-7).reduce((sum, r) => sum + (Number(r.clicks) || 0), 0);

  return {
    id: site.id,
    name: site.name,
    onboardedAt: site.onboarded_at,
    healthScoreProjection: projectHealthScore(allFindings, implementedFindingIds, catByAgent),
    clicksProjection: projectClicks(allFindings, implementedFindingIds, baselineWeeklyClicks),
    impressionsProjection: projectImpressions(recentDaily),
  };
}
