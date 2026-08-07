import { getLatestFindings } from './fresh-runs.js';
import { getQueriesForPage, getSiteById } from '../../store/read.js';
import { getDraftedFindingIds, listDrafts } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';
import { classify } from './recommendation-taxonomy.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { isPageMapped } from '../../implementers/lib/url-file-map.js';

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
  const [runs, geoAuditRun, draftedFindingIds, catByAgent, site] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    latestGeoAuditRun(siteId),
    getDraftedFindingIds(siteId),
    categoryByAgentId(),
    getSiteById(siteId),
  ]);
  const allRuns = geoAuditRun ? [...runs, geoAuditRun] : runs;
  const lookupQuery = makeQueryLookup(siteId);
  const items = [];
  const lastAnalyzedAt = {};
  // Every generatorId+page this run's agents still flag, independent of the
  // draftedFindingIds filter below — an unshipped draft must NOT make its
  // still-live finding look "resolved" to syncFromGrounded's auto-close
  // (recommendation-coordinator.js), or a pending draft's recommendation row
  // would get closed out from under it before it's ever shipped.
  const detectedKeys = new Set();
  // Everything syncFromGrounded's auto-close (recommendation-coordinator.js)
  // needs to tell "this page's finding is genuinely gone" apart from "this
  // page just wasn't in today's rotation batch." Most agents (technical-seo,
  // security-headers, ai-visibility, mobile-usability, geo-signals,
  // content-gap, accessibility, internal-linking) only examine a bounded
  // rotation batch per run (see agents/lib/candidate-pages.js) — a
  // generatorId+page missing from this run's findings for one of them means
  // "not re-checked today" far more often than "fixed." Agents that check
  // everything relevant every run (no rotation) never set facts.checkedPages,
  // so they're absent from batchRotatedAgentIds and keep the original
  // close-on-absence behavior — their non-detection is already trustworthy.
  const agentCheckedKeys = new Set(); // `${agentId}::${page}`
  const linkCrawlCheckedKeys = new Set(); // broken-link-fix only: narrower than technical-seo's own batch, since crawlInternalLinks caps total hrefs checked independently of which pages are in the batch
  const batchRotatedAgentIds = new Set();

  for (const run of allRuns) {
    lastAnalyzedAt[run.agentId] = run.createdAt;
    if (run.checkedPages) {
      batchRotatedAgentIds.add(run.agentId);
      for (const page of run.checkedPages) agentCheckedKeys.add(`${run.agentId}::${page}`);
    }
    if (run.linkCrawlCheckedPages) {
      for (const page of run.linkCrawlCheckedPages) linkCrawlCheckedKeys.add(page);
    }
    for (const f of run.findings) {
      const action = f.recommendedAction;
      if (!action?.generatorId) continue;
      // A page-scoped finding whose page has no real deploy target (no
      // url_file_map entry, no adapter route) can never actually be
      // applied — surfacing it as an "auto-eligible" recommendation only
      // for it to fail with "No url_file_map entry matches..." at
      // approve/apply time. Skip it entirely (not added to detectedKeys
      // either) so any already-open recommendation for it closes out on
      // the next sync instead of staying stuck. See
      // implementers/lib/url-file-map.js's isPageMapped and
      // scripts/audit-url-file-map.js, which surfaces this same gap
      // proactively for a whole site's config.
      // broken-link-fix is excluded: computeBrokenLinkFixMerge (backend.js)
      // has its own GitHub code-search fallback for exactly the pages this
      // check would flag, so "not in url_file_map" isn't fatal for it the
      // way it is for every other generatorId here.
      if (action.generatorId !== 'broken-link-fix' && action.params?.page && site
        && !isPageMapped(site, action.params.page, action.generatorId)) continue;
      detectedKeys.add(`${action.generatorId}::${recommendationPageKey({ generatorId: action.generatorId, params: action.params })}`);
      if (draftedFindingIds.has(f.id)) continue; // a draft already exists — show it only in the Drafts tab, don't resurface here until it's deleted or the agent's own next re-check organically drops it
      const params = { ...action.params };
      if ((action.generatorId === 'meta-title' || action.generatorId === 'faq') && !params.query) {
        if (!params.page || !run.start || !run.end) continue; // no grounding possible
        params.query = await lookupQuery(run.start, run.end, params.page);
        if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
      }
      const { bucket, category } = classify({ source: run.agentId, generatorId: action.generatorId });
      items.push({
        id: f.id, source: run.agentId,
        agentName: run.agentId === 'geo-audit' ? 'GEO Audit' : (catByAgent.get(run.agentId)?.name || run.agentId),
        tag: action.label, generatorId: action.generatorId,
        reason: f.whyItMatters, params, priority: f.priority, expectedImpact: f.expectedImpact,
        bucket, category,
      });
    }
  }
  return { items, lastAnalyzedAt, detectedKeys, agentCheckedKeys, linkCrawlCheckedKeys, batchRotatedAgentIds };
}
