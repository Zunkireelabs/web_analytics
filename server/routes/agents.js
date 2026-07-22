import { Router } from 'express';
import { requireAuth } from './login.js';
import { listAgentMeta } from '../agents/registry.js';
import { runAgent } from '../agents/runner.js';
import { getAgentRunHistory, getLatestAgentRuns } from '../store/agent-runs.js';
import { getAgentActivityFeed } from '../agents/lib/command-center.js';
import { subscribeActivity } from '../agents/lib/activity-bus.js';

const router = Router();
router.use(requireAuth);

// List every registered agent's metadata (id/name/description/category/dataSources).
router.get('/agents', async (req, res, next) => {
  try {
    res.json(await listAgentMeta());
  } catch (e) { next(e); }
});

// Meta joined with each agent's real latest persisted run for the caller's
// own site — powers the orchestration diagram's live status per node
// (never a fabricated/simulated "running" state, only what's actually in
// agent_runs). Same join pattern as /integrations/health.
router.get('/agents/status', async (req, res, next) => {
  try {
    const meta = await listAgentMeta();
    const rows = await getLatestAgentRuns(req.siteId, meta.map((m) => m.id));
    const byId = new Map(rows.map((r) => [r.agent_id, r]));
    res.json(meta.map((m) => {
      const row = byId.get(m.id);
      return {
        ...m,
        lastRunStatus: row?.status || null,
        lastRunAt: row?.created_at || null,
        lastRunFindings: Array.isArray(row?.facts?.findings) ? row.facts.findings.length : null,
      };
    }));
  } catch (e) { next(e); }
});

// Real recent runs across every registered agent, newest first — powers the
// orchestration diagram's live activity rail (AiGrowth.jsx). ?limit
router.get('/agents/activity', async (req, res, next) => {
  try {
    const { limit } = req.query;
    const meta = await listAgentMeta();
    res.json(await getAgentActivityFeed(req.siteId, meta.map((m) => m.id), Number(limit) || 12));
  } catch (e) { next(e); }
});

// Real-time stream of agent start/done events for the caller's site — see
// agents/lib/activity-bus.js. Fires for ANY real run on this site (a manual
// click from this page, the nightly cron, or the orchestrator's fan-out
// behind Command Center/Executive Report), not just runs started from this
// tab — this is what makes the orchestration diagram a live operations view
// instead of a "click to simulate" toy.
router.get('/agents/live', (req, res) => {
  req.socket.setTimeout(0); // long-lived by design — don't let Node's socket idle timeout kill it
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = subscribeActivity(req.siteId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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
