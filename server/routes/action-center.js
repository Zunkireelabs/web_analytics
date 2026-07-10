import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { runAgent } from '../agents/runner.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { getQueriesForPage } from '../store/read.js';
import { listGeneratorMeta, getGenerator } from '../generators/registry.js';
import { createDraft, listDrafts, getDraft, updateDraft, deleteDraft } from '../store/drafts.js';

const router = Router();
router.use(requireAuth, requireInternalSite);

// The 4 agents whose output contains real, generator-mappable
// recommendations. query-intelligence/device-intelligence/executive-report
// are excluded — they have no findings that map to any of the 7 draftable
// action types (see the product review's per-agent trace).
const RECOMMENDATION_AGENT_IDS = ['opportunity', 'content-gap', 'ai-visibility', 'country-intelligence'];

// Maps a recommendation/gap string (short tags like "Add FAQ", full
// sentences like "Add an FAQ section.", or gap types like "Missing FAQ")
// to a generator id via keyword matching — handles every source agent's
// differently-shaped text with one function instead of three lookup tables.
// Recommendations with no mapping (e.g. "Missing alt text") are filtered
// out rather than forced onto a generator that doesn't fit.
function mapToGenerator(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('title')) return 'meta-title';
  if (t.includes('meta')) return 'meta-title';
  if (t.includes('faq') || t.includes('question-style') || t.includes('question style')) return 'faq';
  if (t.includes('entity schema') || t.includes('schema')) return 'schema';
  if (t.includes('internal link')) return 'internal-links';
  return null;
}

// Real top query for a page, looked up on demand and cached per call — only
// needed for sources (ai-visibility) whose facts don't already carry a
// query, so a meta-title/faq draft is never generated ungrounded.
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

async function buildRecommendations(siteId) {
  const runs = await getLatestAgentRuns(siteId, RECOMMENDATION_AGENT_IDS);
  const byId = new Map(runs.map((r) => [r.agent_id, r]));
  const lookupQuery = makeQueryLookup(siteId);
  const items = [];

  const opp = byId.get('opportunity');
  if (opp?.status === 'ok') {
    for (const o of opp.facts.opportunities || []) {
      for (const tag of o.recommendations || []) {
        const generatorId = mapToGenerator(tag);
        if (!generatorId) continue;
        items.push({
          id: `opportunity:${o.page}:${o.query}:${tag}`,
          source: 'opportunity', tag, generatorId,
          reason: `"${o.query}" ranks #${Number(o.avgPosition).toFixed(1)}, ${o.impressions} impressions — est. +${o.estimatedTrafficGain} clicks if improved.`,
          params: { page: o.page, query: o.query, schemaType: 'Article' },
        });
      }
    }
  }

  const gap = byId.get('content-gap');
  if (gap?.status === 'ok') {
    for (const p of gap.facts.pages || []) {
      for (const g of p.gaps || []) {
        const generatorId = mapToGenerator(g.type);
        if (!generatorId) continue;
        items.push({
          id: `content-gap:${p.page}:${g.type}`,
          source: 'content-gap', tag: g.type, generatorId,
          reason: g.detail,
          params: { page: p.page, query: p.topQueries?.[0] || '', schemaType: 'Article' },
        });
      }
      for (const s of p.aiSuggestions || []) {
        items.push({
          id: `content-gap:${p.page}:entity:${s.entity}`,
          source: 'content-gap', tag: `Cover: ${s.entity}`, generatorId: 'blog-outline',
          reason: `${s.rationale} (AI-suggested, confidence: ${s.confidence})`,
          params: { topic: s.entity, context: `Related to existing page ${p.page}. ${s.rationale}` },
        });
      }
    }
  }

  const vis = byId.get('ai-visibility');
  if (vis?.status === 'ok') {
    const { start, end } = vis.input || {};
    for (const p of vis.facts.pages || []) {
      for (const rec of p.recommendations || []) {
        const generatorId = mapToGenerator(rec);
        if (!generatorId) continue;
        const params = { page: p.page, schemaType: 'Article' };
        if (generatorId === 'meta-title' || generatorId === 'faq') {
          params.query = start && end ? await lookupQuery(start, end, p.page) : '';
          if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
        }
        items.push({
          id: `ai-visibility:${p.page}:${rec}`,
          source: 'ai-visibility', tag: rec, generatorId,
          reason: `AI Visibility score ${p.score?.overall ?? '—'}/100 for this page.`,
          params,
        });
      }
    }
  }

  const country = byId.get('country-intelligence');
  if (country?.status === 'ok') {
    for (const r of country.facts.recommendations || []) {
      items.push({
        id: `country-intelligence:${r.tag}:${r.params.market || r.params.city || r.params.targetLanguage}`,
        source: 'country-intelligence', tag: r.tag, generatorId: r.generatorId,
        reason: r.reason, params: r.params,
      });
    }
  }

  const lastAnalyzedAt = Object.fromEntries(runs.map((r) => [r.agent_id, r.created_at]));
  return { items, lastAnalyzedAt };
}

// Most recent persisted recommendations — instant, may be stale. `Refresh`
// below re-runs the agents fresh.
router.get('/action-center/recommendations', async (req, res, next) => {
  try {
    res.json(await buildRecommendations(req.siteId));
  } catch (e) { next(e); }
});

// Re-runs the 4 recommendation-bearing agents fresh (each several seconds —
// real page fetches + LLM calls) for the given range, persists them like any
// other agent run, then rebuilds the recommendation list from the fresh data.
router.post('/action-center/recommendations/refresh', async (req, res, next) => {
  try {
    const { start, end } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
    await Promise.all(RECOMMENDATION_AGENT_IDS.map((id) =>
      runAgent(id, { siteId: req.siteId, start, end }).catch((err) => {
        console.error(`[action-center] refresh failed for agent "${id}":`, err.message);
      })
    ));
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
