import { getLatestFindings } from './fresh-runs.js';
import { getQueriesForPage, getSiteById } from '../../store/read.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { categoryByAgentId } from './command-center.js';
import { classify } from './recommendation-taxonomy.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { isPageMapped, resolveAdapter, resolveFile, resolveNewContentTarget } from '../../implementers/lib/url-file-map.js';
import { componentTemplateVerification, componentTemplateActionTypeFor } from '../../implementers/lib/design-drift.js';
import { isDataReady } from '../../implementers/adapters/data-array-content.js';
import { FRONTEND_ACTION_TYPES } from '../../implementers/frontend.js';
import { getFileContent, getRepoTree } from '../../github/client.js';
import { baseBranch } from '../../implementers/lib/github-ops.js';
import { autoHealFileMapping } from '../../implementers/lib/discover-file-mapping.js';

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
  // Reassignable: healUnmappedPage below persists newly-discovered url_file_map
  // entries and returns the updated row, and later findings in the same pass
  // must see them — otherwise two findings on one page would each try to heal
  // it, and the second would still read the stale map.
  let site = loadedSite;
  const lookupQuery = makeQueryLookup(siteId);
  // One real GitHub read per unique data file for this whole refresh, no
  // matter how many candidate pages share it (e.g. every /locations/:city/
  // page routes through the same locations.js) — same caching idiom
  // audit-url-file-map.js already uses, so isDataReady below stays cheap
  // even across a large candidate-page pool.
  const dataFileCache = new Map(); // `${path}@${ref}` -> file | null
  // "We could not check" is NOT the same as "it is not there", and conflating
  // them is how a revoked token or a rate limit silently empties a tenant's
  // Action Center. getFileContent already draws the line correctly — it returns
  // null only for a real 404 and throws on anything else — but the old
  // `.catch(() => null)` here threw that distinction away, so a 401 read as
  // evidence that a live page was a soft-404 and the finding was dropped.
  // Tracked separately so cachedFetchFile keeps its existing file|null contract
  // for isDataReady, which genuinely does want "no data" for both cases.
  const unverifiableFiles = new Set(); // `${path}@${ref}`
  const cachedFetchFile = async (s, path, ref) => {
    const key = `${path}@${ref}`;
    if (dataFileCache.has(key)) return dataFileCache.get(key);
    let file = null;
    try {
      file = await getFileContent(s, path, ref);
    } catch (err) {
      unverifiableFiles.add(key);
      console.warn(`[recommendations] site ${siteId}: could not verify ${path} exists (${err.message}) — not treating that as absent.`);
    }
    dataFileCache.set(key, file);
    return file;
  };
  // One repo-tree read for this whole refresh no matter how many unmapped pages
  // need discovering — same caching idiom as cachedFetchFile above, and the
  // reason autoHealFileMapping takes an injectable fetchTree at all: the tree is
  // identical for every page on the same branch, and getRepoTree costs two
  // GitHub calls each time.
  const treeCache = new Map(); // `${siteId}@${branch}` -> { files, truncated }
  const cachedFetchTree = async (s, branch) => {
    const key = `${s.id}@${branch}`;
    if (!treeCache.has(key)) treeCache.set(key, await getRepoTree(s, branch));
    return treeCache.get(key);
  };
  // Attempts are deduped per (page, actionType) rather than per page: whether a
  // page needs file-mapping healing at all depends on the action type, because
  // an adapter configured for one type and not another makes
  // autoHealFileMapping bail early for the former only. Keyed on page alone, a
  // page whose faq route is adapter-handled would suppress the genuine attempt
  // for its schema route.
  const healAttempted = new Set();
  const healUnmappedPage = async (currentSite, pageUrl, actionType) => {
    if (!currentSite?.repo_owner || !currentSite?.repo_name) return currentSite;
    const key = `${pageUrl}::${actionType}`;
    if (healAttempted.has(key)) return currentSite;
    healAttempted.add(key);
    // Never fatal: this is an opportunistic upgrade of a recommendation from
    // "blocked" to "actionable". A rate-limited or unreachable repo must leave
    // the finding visible-and-blocked, not take down the whole refresh.
    const healed = await autoHealFileMapping(currentSite, pageUrl, actionType, { fetchTree: cachedFetchTree })
      .catch((err) => {
        console.warn(`[recommendations] site ${siteId}: could not auto-discover a file mapping for ${pageUrl}:`, err.message);
        return null;
      });
    return healed || currentSite;
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
      // url_file_map entry, no adapter route) can't be applied yet — it would
      // fail with "No url_file_map entry matches..." at approve/apply time.
      //
      // This used to `continue`, dropping the finding entirely. That was wrong,
      // and wrong in the most misleading direction: a tenant whose repo has not
      // been mapped yet has EVERY page-scoped finding discarded here, so their
      // Action Center renders near-empty and reads as "my site is healthy" when
      // it actually means "we never configured your repo." Confirmed against
      // the live DB: sites 6, 7 and 8 have an empty url_file_map, so this line
      // was silently throwing away every real page-scoped issue we found for
      // them.
      //
      // It was also a deadlock. autoHealFileMapping (implementers/lib/
      // discover-file-mapping.js) can often resolve a page's file on its own by
      // matching the URL's last segment against the real repo tree — but it
      // only ran at push time, and a finding dropped HERE never reaches push
      // time. So the mapping could never heal for exactly the tenants that
      // needed it. healUnmappedPage below is that same function, moved to where
      // the decision is actually made.
      //
      // Unlike the two gates below it, this one is OUR configuration gap, not a
      // fact about the tenant's site: the issue is real and the page is real.
      // So it stays visible carrying a reason, is added to detectedKeys (it must
      // NOT auto-close as "resolved" — nothing was resolved), and
      // recommendation-coordinator.js forces it to the 'manual' tier so it can
      // never enter the unattended chain. Same treatment as the design gate.
      //
      // broken-link-fix is excluded: computeBrokenLinkFixMerge (backend.js)
      // has its own GitHub code-search fallback for exactly the pages this
      // check would flag, so "not in url_file_map" isn't fatal for it the
      // way it is for every other generatorId here.
      let mappingBlockedReason = null;
      // The net-new counterpart of the page-mapping gate below. Net-new content
      // (blog-outline, direct-answer, landing-page, the legal pages) has no
      // params.page to map — it resolves its destination through
      // url_file_map.newContentTargets instead, and frontend.js hard-fails with
      // 'no-file-mapping' at apply time when that entry is absent.
      //
      // This is what makes promoting blog-outline to the safe tier honest for
      // EVERY tenant rather than just the one that happens to be configured.
      // Site 1 has a real newContentTargets['blog-outline'], so its blog
      // recommendations are actionable; a newly-onboarded tenant has none, so
      // theirs stay visible-and-blocked with a reason and are demoted to the
      // manual tier — never silently queued into the unattended chain to fail
      // 30 times at apply. When the config lands, they unblock on the next sync
      // with no manual step.
      //
      // Deliberately checks only the target's existence. The second
      // prerequisite for markdown content — a renderCapabilities entry proving
      // the extension gets a markdown pass — is enforced by
      // rendering-gate.js's validateRenderingBatch inside pushDraftBranch,
      // which fails closed and is the single choke point every implementer
      // funnels through. Duplicating that rule here would give it two
      // definitions that could disagree.
      if (site && FRONTEND_ACTION_TYPES.has(action.generatorId)
        && !resolveNewContentTarget(site, action.generatorId, 'probe')) {
        mappingBlockedReason = `No url_file_map.newContentTargets["${action.generatorId}"] is configured for this site, so there is nowhere in the repo to create the new file. Add one (e.g. {"dir":"src/blog","extension":".md"}) via 'npm run connect-repo' before this can be applied.`;
      }
      if (action.generatorId !== 'broken-link-fix' && action.params?.page && site
        && !isPageMapped(site, action.params.page, action.generatorId)) {
        site = await healUnmappedPage(site, action.params.page, action.generatorId);
        if (!isPageMapped(site, action.params.page, action.generatorId)) {
          mappingBlockedReason = `No url_file_map entry resolves ${action.params.page} to a file in this site's repo, and it could not be discovered automatically. Add a mapping via 'npm run connect-repo' (or 'npm run audit-url-file-map -- --site-id <id>' to see every gap) before this can be applied.`;
        }
      }
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
        if (filePath) {
          const ref = baseBranch(site);
          const exists = await cachedFetchFile(site, filePath, ref);
          // Drop ONLY on a definitive 404. If the read failed for any other
          // reason we have no evidence either way, and dropping would repeat
          // the very bug this gate's own comment warns about — inventing a
          // conclusion from an unverified guess, just in the opposite
          // direction. Left in place, it is caught by the real apply-time
          // checks instead, which fail loudly rather than silently.
          if (!exists && !unverifiableFiles.has(`${filePath}@${ref}`)) continue;
        }
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
      // Design-verification gate. Like the url_file_map gate above (and unlike
      // the two that drop their items), this one does NOT `continue` — a blocked
      // item is a real, correctly-detected issue we simply aren't allowed to
      // auto-fix yet, so dropping it would lose a genuine finding and let the
      // recommendation close out as "resolved" when nothing was resolved. It
      // stays visible, carries its reason, and recommendation-coordinator.js
      // forces it to the 'manual' risk tier so it can never enter the unattended
      // safe-fix chain. The real hard block (a 422) lives in generateDraft —
      // this is the honest UI half of it, so a user sees "blocked, here's why"
      // instead of clicking Generate and getting an error.
      // Pure in-memory check against the already-loaded `site` row — no
      // network or DB access, safe inside this per-finding loop.
      const designCheck = site
        ? componentTemplateVerification(site, componentTemplateActionTypeFor(action.generatorId))
        : { ok: true };

      // Both blockers land in one field. The reason text says which one it was,
      // and nothing downstream needs to branch on the kind — blockedRiskTier
      // only checks truthiness. The mapping block is reported first when both
      // apply, because it's the more fundamental one: there is no point telling
      // someone to verify a component template for a page we can't locate a
      // file for.
      const blockedReason = mappingBlockedReason || (designCheck.ok ? null : designCheck.detail);

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
