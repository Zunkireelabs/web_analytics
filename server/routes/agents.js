import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { listAgentMeta } from '../agents/registry.js';
import { runAgent } from '../agents/runner.js';
import { getAgentRunHistory } from '../store/agent-runs.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

// List every registered agent's metadata (id/name/description/category/dataSources).
router.get('/agents', async (req, res, next) => {
  try {
    res.json(await listAgentMeta());
  } catch (e) { next(e); }
});

// Run one agent by id, scoped to the caller's own site. POST { start, end, params }
router.post('/agents/:id/run', async (req, res, next) => {
  try {
    const { start, end, params } = req.body || {};
    const output = await runAgent(req.params.id, { siteId: req.siteId, start, end, params });
    res.json(output);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Recent run history for one agent on the caller's own site. ?limit
router.get('/agents/:id/runs', async (req, res, next) => {
  try {
    const { limit } = req.query;
    res.json(await getAgentRunHistory(req.siteId, req.params.id, Number(limit) || 10));
  } catch (e) { next(e); }
});

export default router;
