import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { runOrchestration } from '../agents/orchestrator.js';
import { getLatestFindings } from '../store/agent-runs.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { getQueriesForPage } from '../store/read.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import { createDraft, listDrafts, getDraft, updateDraft, deleteDraft } from '../store/drafts.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

// Real top query for a page, looked up on demand and cached per call — only
// needed when a finding's recommendedAction wants a query param but the
// source agent's facts don't already carry one (e.g. ai-visibility), so a
// meta-title/faq draft is never generated ungrounded.
function makeQueryLookup(siteId) {
  const cache = new Map();
  return async (start, end, page) => {
    const key = `${start}|${end}|${page}`;
    if (cache.has(key)) return cache.get(key);
    const rows = await getQueriesForPage(siteId, start, end, page, 1);
    const q = rows[0]?.query || '';
    cache.set(key, q);
    return q;
  };
}

// Every recommendation-bearing agent sets `recommendedAction.generatorId`
// directly (agents/lib/page-content.js's TAG_TO_GENERATOR/GAP_TYPE_TO_
// GENERATOR, or an agent's own generatorId like country-intelligence) — this
// just reads it. No more downstream keyword-guessing (the old mapToGenerator)
// that could silently drop a recommendation if its wording didn't match.
async function buildRecommendations(siteId) {
  const runs = await getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS);
  const lookupQuery = makeQueryLookup(siteId);
  const items = [];
  const lastAnalyzedAt = {};

  for (const run of runs) {
    lastAnalyzedAt[run.agentId] = run.createdAt;
    for (const f of run.findings) {
      const action = f.recommendedAction;
      if (!action?.generatorId) continue;
      const params = { ...action.params };
      if ((action.generatorId === 'meta-title' || action.generatorId === 'faq') && !params.query) {
        if (!params.page || !run.start || !run.end) continue; // no grounding possible
        params.query = await lookupQuery(run.start, run.end, params.page);
        if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
      }
      items.push({ id: f.id, source: run.agentId, tag: action.label, generatorId: action.generatorId, reason: f.whyItMatters, params });
    }
  }
  return { items, lastAnalyzedAt };
}

// Most recent persisted recommendations — instant, may be stale. `Refresh`
// below re-runs the agents fresh.
router.get('/action-center/recommendations', async (req, res, next) => {
  try {
    res.json(await buildRecommendations(req.siteId));
  } catch (e) { next(e); }
});

// Re-runs the 6 recommendation-bearing agents fresh (each several seconds —
// real page fetches + LLM calls) for the given range via the shared
// orchestrator (persisting each sub-agent run like any other agent run),
// then rebuilds the recommendation list from the fresh data.
router.post('/action-center/recommendations/refresh', async (req, res, next) => {
  try {
    const { start, end } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
    await runOrchestration({ siteId: req.siteId, start, end, agentIds: RECOMMENDATION_AGENT_IDS, persistSubAgentRuns: true });
    res.json(await buildRecommendations(req.siteId));
  } catch (e) { next(e); }
});

router.get('/action-center/generators', async (req, res, next) => {
  try {
    res.json(await listGeneratorMeta());
  } catch (e) { next(e); }
});

// Runs one generator and persists the result as a new draft. Never writes
// anywhere else — no publish path exists.
router.post('/action-center/generate', async (req, res, next) => {
  try {
    const { generatorId, params, source } = req.body || {};
    if (!generatorId) return res.status(400).json({ error: 'generatorId is required' });
    const generator = await getGenerator(generatorId);
    if (!generator) return res.status(404).json({ error: `Unknown generator "${generatorId}"` });

    const { content, summary } = await generator.generate({ siteId: req.siteId, params: params || {} });
    const draft = await createDraft(req.siteId, {
      actionType: generatorId, source: source || 'manual', input: params || {}, content,
    });
    res.json({ ...draft, summary });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.get('/action-center/drafts', async (req, res, next) => {
  try {
    const { actionType, status } = req.query;
    res.json(await listDrafts(req.siteId, { actionType, status }));
  } catch (e) { next(e); }
});

router.get('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const draft = await getDraft(req.siteId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (e) { next(e); }
});

// Edit + Save Draft — content only. No status other than 'draft'/'edited'
// exists; there is no publish transition here or anywhere in this router.
router.put('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const { content } = req.body || {};
    if (content == null) return res.status(400).json({ error: 'content is required' });
    const draft = await updateDraft(req.siteId, req.params.id, { content });
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(draft);
  } catch (e) { next(e); }
});

router.delete('/action-center/drafts/:id', async (req, res, next) => {
  try {
    const ok = await deleteDraft(req.siteId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
