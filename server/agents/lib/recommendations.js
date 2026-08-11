import { getLatestFindings } from './fresh-runs.js';
import { getQueriesForPage, getSiteById } from '../../store/read.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';
import { classify } from './recommendation-taxonomy.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { isPageMapped, resolveAdapter, resolveFile } from '../../implementers/lib/url-file-map.js';
import { componentTemplateVerification, componentTemplateActionTypeFor } from '../../implementers/lib/design-drift.js';
import { isDataReady } from '../../implementers/adapters/data-array-content.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch } from '../../implementers/lib/github-ops.js';

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
  const [runs, draftedFindingIds, catByAgent, site] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    getDraftedFindingIds(siteId),
    categoryByAgentId(),
    getSiteById(siteId),
  ]);
  const lookupQuery = makeQueryLookup(siteId);
  // One real GitHub read per unique data file for this whole refresh, no
  // matter how many candidate pages share it (e.g. every /locations/:city/
  // page routes through the same locations.js) — same caching idiom
  // audit-url-file-map.js already uses, so isDataReady below stays cheap
  // even across a large candidate-page pool.
  const dataFileCache = new Map(); // `${path}@${ref}` -> file | null
  const cachedFetchFile = async (site, path, ref) => {
    const key = `${path}@${ref}`;
    if (dataFileCache.has(key)) return dataFileCache.get(key);
    const file = await getFileContent(site, path, ref).catch(() => null);
    dataFileCache.set(key, file);
    return file;
  };
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
      // isPageMapped above only proves url_file_map SYNTACTICALLY resolves a
      // path (an exact `pages[]` entry, or a `patterns[]` regex match) — it
      // never confirms that resolved file genuinely exists in the repo. A
      // generic catch-all pattern (e.g. `^/([a-z0-9-]+)/?$` -> "src/pages/
      // $1.njk") matches any URL that merely LOOKS like a real page, and
      // many static-site nginx configs make that trivially true for URLs
      // that were never real: a `try_files ... /index.html` SPA fallback
      // (this codebase's own nginx/static.conf, and a common Eleventy/Vite
      // deploy pattern) returns HTTP 200 for literally any path, so a
      // crawl/GSC-discovered URL for a renamed or nonexistent page still
      // looks "live." Real incident: zunkireelabs.com/ai-agents/ (a soft-404
      // — no template anywhere sets that permalink) matched the generic
      // pattern to a nonexistent src/pages/ai-agents.njk, and the resulting
      // recommendation showed "SAFE — AUTO-ELIGIBLE" right up until someone
      // approved it. Verified live here, once per unique file per refresh
      // (cachedFetchFile below already dedupes/caches this exact call for
      // isDataReady) — skip the same as an unmapped page rather than let an
      // unverified guess reach the UI as "safe." Adapter-routed pages
      // (resolveFile returns null for those) are unaffected; their own
      // adapter validates itself below.
      if (action.generatorId !== 'broken-link-fix' && action.params?.page && site) {
        const filePath = resolveFile(site, action.params.page);
        if (filePath && !(await cachedFetchFile(site, filePath, baseBranch(site)))) continue;
      }
      // isPageMapped above only confirms a ROUTE exists (a file, or an
      // adapter configured for this actionType) — for data-array-content
      // specifically, that route can be configured while the adapter's own
      // data still has nothing for this exact page (e.g. a location with
      // no `services.web-development` entry yet). Checked here, not just
      // inside the adapter's own apply(), so a recommendation that can
      // never actually apply stops resurfacing every refresh — the same
      // "known dead end" a human would eventually notice and stop
      // clicking, minus the frustration of noticing it themselves.
      if (action.generatorId !== 'broken-link-fix' && action.params?.page && site) {
        const adapterConfig = resolveAdapter(site, action.params.page, action.generatorId);
        if (adapterConfig?.id === 'data-array-content'
          && !(await isDataReady(site, action.params.page, adapterConfig, cachedFetchFile, baseBranch(site)))) continue;
      }
      detectedKeys.add(`${action.generatorId}::${recommendationPageKey({ generatorId: action.generatorId, params: action.params })}`);
      if (draftedFindingIds.has(f.id)) continue; // a draft already exists — show it only in the Drafts tab, don't resurface here until it's deleted or the agent's own next re-check organically drops it
      const params = { ...action.params };
      if ((action.generatorId === 'meta-title' || action.generatorId === 'faq') && !params.query) {
        if (!params.page || !run.start || !run.end) continue; // no grounding possible
        params.query = await lookupQuery(run.start, run.end, params.page);
        if (!params.query) continue; // never generate title/FAQ drafts without a real grounding query
      }
      // Design-verification gate. Unlike the three gates above, this one does
      // NOT `continue` — a blocked item is a real, correctly-detected issue
      // we simply aren't allowed to auto-fix yet, so dropping it would lose a
      // genuine finding and let the recommendation close out as "resolved"
      // when nothing was resolved. It stays visible, carries its reason, and
      // recommendation-coordinator.js forces it to the 'manual' risk tier so
      // it can never enter the unattended safe-fix chain. The real hard block
      // (a 422) lives in generateDraft — this is the honest UI half of it, so
      // a user sees "blocked, here's why" instead of clicking Generate and
      // getting an error.
      // Pure in-memory check against the already-loaded `site` row — no
      // network or DB access, safe inside this per-finding loop.
      const designCheck = site
        ? componentTemplateVerification(site, componentTemplateActionTypeFor(action.generatorId))
        : { ok: true };

      const { bucket, category } = classify({ source: run.agentId, generatorId: action.generatorId });
      items.push({
        id: f.id, source: run.agentId,
        agentName: run.agentId === 'geo-audit' ? 'GEO Audit' : (catByAgent.get(run.agentId)?.name || run.agentId),
        tag: action.label, generatorId: action.generatorId,
        reason: f.whyItMatters, params, priority: f.priority, expectedImpact: f.expectedImpact,
        bucket, category,
        designBlockedReason: designCheck.ok ? null : designCheck.detail,
      });
    }
  }
  return { items, lastAnalyzedAt, detectedKeys, agentCheckedKeys, linkCrawlCheckedKeys, batchRotatedAgentIds };
}
