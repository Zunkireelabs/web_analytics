import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { getCommandCenterData } from '../agents/lib/command-center.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { saveAgentRun } from '../store/agent-runs.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { meta as execReportMeta } from '../agents/executive-report.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { syncWatchlist } from '../agents/lib/watchlist.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

// Reads only already-persisted agent runs — never triggers a live run, same
// "instant, may be stale" contract as Action Center's recommendations route.
router.get('/command-center', async (req, res, next) => {
  try {
    res.json(await getCommandCenterData(req.siteId));
  } catch (e) { next(e); }
});

// Re-runs the primary agents fresh via the shared orchestrator (persisting
// each, so Discoveries/Opportunities/Actions all update together), then
// persists that same orchestration result as the executive-report row too —
// reusing runOrchestration's output directly instead of a second call to
// executive-report.js, which would silently re-run every agent a second
// time (double the page fetches/LLM calls for one "Refresh" click).
router.post('/command-center/refresh', async (req, res, next) => {
  try {
    const { start, end } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end are required' });

    const result = await runOrchestration({ siteId: req.siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
    await saveAgentRun({
      siteId: req.siteId, agentId: 'executive-report', agentVersion: execReportMeta.version,
      input: { siteId: req.siteId, start, end }, status: 'ok',
      facts: { rangeStart: start, rangeEnd: end, sections: result.perAgent, topFindings: result.findings.slice(0, 3), findings: result.findings },
      narrative: result.narrative, error: null, tookMs: null,
    });

    // Opportunity Watchlist syncs on every fresh analysis, same as the daily
    // cron path (server/job.js) — auto-adds newly-qualifying opportunities,
    // auto-closes ones that fell out of this run.
    const recommendations = await buildRecommendations(req.siteId);
    const groundedById = new Map(recommendations.items.map((item) => [item.id, item]));
    await syncWatchlist(req.siteId, result.findings, groundedById)
      .catch((err) => console.error(`[command-center] watchlist sync failed for site ${req.siteId}:`, err.message));

    res.json(await getCommandCenterData(req.siteId));
  } catch (e) { next(e); }
});

export default router;
