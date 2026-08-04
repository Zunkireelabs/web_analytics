import { getLatestFindings } from './fresh-runs.js';
import { getQueriesForPage } from '../../store/read.js';
import { getDraftedFindingIds, listDrafts } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';

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

// The GEO Audit generator (server/generators/geo-audit.js) is a generator,
// not one of RECOMMENDATION_AGENT_IDS's agents, so its findings never come
// through getLatestFindings/agent_runs — they're persisted inside its own
// most recent draft's content.findings instead (built by
// agents/lib/geo-audit-report.js). Reshaped into a run-shaped object here
// so the loop below can treat it exactly like every other source, with zero
// special-casing downstream.
async function latestGeoAuditRun(siteId) {
  const [latest] = await listDrafts(siteId, { actionType: 'geo-audit' });
  const findings = latest?.content?.findings;
  if (!Array.isArray(findings) || !findings.length) return null;
  return { agentId: 'geo-audit', findings, start: latest.content.start, end: latest.content.end, createdAt: latest.created_at };
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
  const [runs, geoAuditRun, draftedFindingIds, catByAgent] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    latestGeoAuditRun(siteId),
    getDraftedFindingIds(siteId),
    categoryByAgentId(),
  ]);
  const allRuns = geoAuditRun ? [...runs, geoAuditRun] : runs;
  const lookupQuery = makeQueryLookup(siteId);
  const items = [];
  const lastAnalyzedAt = {};

  for (const run of allRuns) {
    lastAnalyzedAt[run.agentId] = run.createdAt;
    for (const f of run.findings) {
      if (draftedFindingIds.has(f.id)) continue; // a draft already exists — show it only in the Drafts tab, don't resurface here until it's deleted or the agent's own next re-check organically drops it
      const action = f.recommendedAction;
      if (!action?.generatorId) continue;
      const params = { ...action.params };
      if ((action.generatorId === 'meta-title' || action.generatorId === 'faq') && !params.query) {
        if (!params.page || !run.start || !run.end) continue; // no grounding possible
        params.query = await lookupQuery(run.start, run.end, params.page);
        if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
      }
      items.push({
        id: f.id, source: run.agentId,
        agentName: run.agentId === 'geo-audit' ? 'GEO Audit' : (catByAgent.get(run.agentId)?.name || run.agentId),
        tag: action.label, generatorId: action.generatorId,
        reason: f.whyItMatters, params, priority: f.priority, expectedImpact: f.expectedImpact,
      });
    }
  }
  return { items, lastAnalyzedAt };
}
