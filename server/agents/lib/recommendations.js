import { getLatestFindings } from './fresh-runs.js';
import { getQueriesForPage, getSiteById } from '../../store/read.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';
import { classify } from './recommendation-taxonomy.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { createRecommendationGates } from './recommendation-gates.js';

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

// GEO Audit (server/generators/geo-audit.js) is deliberately report/score
// only — its own dashboard surface (agent_runs snapshot read by
// command-center.js's geoAuditMeta, plus the report body on its own
// 'geo-audit' draft, both written unconditionally in action-center.js's
// generateDraft) is complete on its own and never depends on the
// `recommendations` table. Its findings (content.findings, built by
// agents/lib/geo-audit-report.js) are NOT fed into buildRecommendations
// below — confirmed with the user 2026-08-10: GEO Audit's findings must
// never become actionable Action Center recommendations a human could draft
// into a PR, only the score/report a human reads. If a future need arises
// to make GEO Audit findings actionable again, reshape content.findings
// into a run-shaped object (as this function used to) and merge it into
// `runs` below — deliberately not done here.

// Every recommendation-bearing agent sets `recommendedAction.generatorId`
// directly (agents/lib/page-content.js's TAG_TO_GENERATOR/GAP_TYPE_TO_
// GENERATOR, or an agent's own generatorId like country-intelligence) — this
// just reads it. No downstream keyword-guessing (the old mapToGenerator)
// that could silently drop a recommendation if its wording didn't match.
// Shared by Action Center (routes/action-center.js) and the AI Command
// Center (agents/lib/command-center.js) — one read+ground implementation,
// not two.
export async function buildRecommendations(siteId) {
  const [runs, draftedFindingIds, catByAgent, loadedSite] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    getDraftedFindingIds(siteId),
    categoryByAgentId(),
    getSiteById(siteId),
  ]);
  // Every gate that decides whether a candidate is real, and whether it may
  // enter the unattended chain, now lives in recommendation-gates.js — shared
  // with the analyst writers in analyst-seo-mapping.js, which previously had no
  // gates at all and could mint a safe, unblocked recommendation for a page
  // with no file mapping or no page at all.
  //
  // It owns the per-pass caches too (one repo tree, one read per unique file,
  // one soft-404 fingerprint), and `gates.site` is the reassignable site row:
  // healing persists newly-discovered url_file_map entries, and later findings
  // in the same pass must see them, or two findings on one page would each try
  // to heal it and the second would still read the stale map.
  const gates = createRecommendationGates(siteId, loadedSite);
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

  for (const run of runs) {
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
      // Every gate — net-new target, url_file_map (with healing), soft-404,
      // file-exists, adapter-data, design verification — in one call, shared
      // with the other writers to this table. See recommendation-gates.js for
      // why each one drops or blocks.
      //
      // drop = not real or never actionable: discard it, and deliberately do
      // NOT add it to detectedKeys, so any already-open row closes on the next
      // sync. blockedReason = real issue on a real page we are not configured
      // to fix automatically yet: keep it visible carrying the reason, and let
      // blockedRiskTier demote it to the manual tier. Dropping those would
      // render a tenant's Action Center near-empty and read as "my site is
      // healthy" when it means "we never configured your repo".
      const gate = await gates.evaluate(action.generatorId, action.params);
      if (gate.drop) continue;
      const blockedReason = gate.blockedReason;
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
        blockedReason,
      });
    }
  }
  return { items, lastAnalyzedAt, detectedKeys, agentCheckedKeys, linkCrawlCheckedKeys, batchRotatedAgentIds };
}
