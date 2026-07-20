import { getLatestFindings } from '../../store/agent-runs.js';
import { getQueriesForPage } from '../../store/read.js';
import { getImplementedFindingIds } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';

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
// just reads it. No downstream keyword-guessing (the old mapToGenerator)
// that could silently drop a recommendation if its wording didn't match.
// Shared by Action Center (routes/action-center.js) and the AI Command
// Center (agents/lib/command-center.js) — one read+ground implementation,
// not two.
export async function buildRecommendations(siteId) {
  const [runs, implementedFindingIds] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    getImplementedFindingIds(siteId),
  ]);
  const lookupQuery = makeQueryLookup(siteId);
  const items = [];
  const lastAnalyzedAt = {};

  for (const run of runs) {
    lastAnalyzedAt[run.agentId] = run.createdAt;
    for (const f of run.findings) {
      if (implementedFindingIds.has(f.id)) continue; // already shipped — don't resurface until the agent's own next re-check organically drops it
      const action = f.recommendedAction;
      if (!action?.generatorId) continue;
      const params = { ...action.params };
      if ((action.generatorId === 'meta-title' || action.generatorId === 'faq') && !params.query) {
        if (!params.page || !run.start || !run.end) continue; // no grounding possible
        params.query = await lookupQuery(run.start, run.end, params.page);
        if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
      }
      items.push({
        id: f.id, source: run.agentId, tag: action.label, generatorId: action.generatorId,
        reason: f.whyItMatters, params, priority: f.priority, expectedImpact: f.expectedImpact,
      });
    }
  }
  return { items, lastAnalyzedAt };
}
