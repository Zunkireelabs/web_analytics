import { Router } from 'express';
import { requireAuth } from './login.js';
import { getCommandCenterData } from '../agents/lib/command-center.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { saveAgentRun } from '../store/agent-runs.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { meta as execReportMeta } from '../agents/executive-report.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { syncWatchlist } from '../agents/lib/watchlist.js';
import { agenticOrchestrationEnabled, runAgenticLoop } from '../agents/lib/agentic-orchestrator.js';
import { buildStalenessContext } from './action-center.js';
import { getAgenticOrchestrationStatsSince } from '../store/agentic-orchestration-runs.js';

const router = Router();
router.use(requireAuth);

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

    // Same enabled-flag branch-with-fallback Action Center's own refresh
    // already uses (server/routes/action-center.js) — previously this route
    // always ran the fixed fan-out regardless of AGENTIC_ORCHESTRATION_ENABLED,
    // meaning the agentic tool-calling loop could never actually be
    // exercised from Command Center's "Run Agent Core"/Orchestration's "Run
    // Audit" buttons. Same {findings, perAgent, narrative} shape either way
    // (both share summarizeAgentRuns), so nothing below needs to branch.
    let result;
    if (agenticOrchestrationEnabled()) {
      try {
        const staleness = await buildStalenessContext(req.siteId);
        result = await runAgenticLoop({ siteId: req.siteId, start, end, staleness, persistSubAgentRuns: true });
      } catch (e) {
        console.warn('[command-center] agentic refresh failed, falling back to full refresh:', e.message);
        result = await runOrchestration({ siteId: req.siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
      }
    } else {
      result = await runOrchestration({ siteId: req.siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
    }
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

// Real, already-persisted agentic-orchestration telemetry (server/agents/lib/
// agentic-orchestrator.js's saveAgenticOrchestrationRun) — this data existed
// before today but had no reader anywhere, so the Orchestration page had no
// way to show which execution mode actually ran. Lean aggregates only, no
// question/finding content (see agentic-orchestration-runs.js's own comment).
router.get('/command-center/agentic-stats', async (req, res, next) => {
  try {
    const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res.json(await getAgenticOrchestrationStatsSince(req.siteId, sinceDate));
  } catch (e) { next(e); }
});

export default router;
