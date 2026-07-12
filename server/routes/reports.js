import { Router } from 'express';
import { requireAuth } from './login.js';
import { getAgentFindings, getPriorityRecommendations } from '../agents/lib/insights.js';

// Client-facing, read-only. Unlike agents.js/action-center.js this router is
// NOT gated by requireInternalSite — it only ever reads already-persisted
// agent_runs (via agents/insights.js), never triggers a run, a page-scrape,
// or a live LLM call. "AI Growth runs agents; Reports consumes the results."
const router = Router();
router.use(requireAuth);

// Page-level (not period-scoped) — agent runs aren't tied to a Daily/Weekly/
// Monthly tab, so this is fetched once per page load, not once per tab.
router.get('/report-insights', async (req, res, next) => {
  try {
    const [agentFindings, recommendations] = await Promise.all([
      getAgentFindings(req.siteId),
      getPriorityRecommendations(req.siteId),
    ]);
    res.json({ agentFindings, recommendations });
  } catch (e) { next(e); }
});

export default router;
