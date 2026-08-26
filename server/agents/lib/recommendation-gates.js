import { isPageMapped, resolveAdapter, resolveFile, resolveNewContentTarget } from '../../implementers/lib/url-file-map.js';
import { componentTemplateVerification, componentTemplateActionTypeFor } from '../../implementers/lib/design-drift.js';
import { getDesignAgentStatus } from '../../implementers/lib/design-agent-status.js';
import { isDataReady } from '../../implementers/adapters/data-array-content.js';
import { fetchSoftNotFoundFingerprint, isSoftNotFound } from './technical-seo-analysis.js';
import { FRONTEND_ACTION_TYPES } from '../../implementers/frontend.js';
import { getFileContent, getRepoTree } from '../../github/client.js';
import { baseBranch } from '../../implementers/lib/github-ops.js';
import { autoHealFileMapping, buildPermalinkIndex } from '../../implementers/lib/discover-file-mapping.js';
import { autoHealNewContentTarget } from '../../implementers/lib/discover-content-target.js';
import { discoverPaginationRoutes, matchPaginationRoute, paginationBlockedReason, paginationHeadTagAutoHandled } from '../../implementers/lib/pagination-routes.js';
import { healPaginationAdapter } from '../../implementers/lib/pagination-adapter-discovery.js';

// The gates that decide whether a candidate recommendation is real, and
// whether it may enter the unattended chain.
//
// This lived inline inside buildRecommendations, which made it the gate for
// exactly one of the three writers to the recommendations table. The other
// two — createActionCenterRecommendationForGap and
// syncAnalystInsightsToActionCenter (analyst-seo-mapping.js) — inserted rows
// with `riskTier: riskTierForGenerator(...)` and no blockedReason at all, so
// the nightly analyst pipeline could mint a 'safe', unblocked recommendation
// for a page with no file mapping, an unverified component template, or no
// page at all. Those rows then went straight into the shipping loop to fail.
//
// Extracted here so every writer asks the same question. New writers should
// call this rather than inventing a fourth answer.
//
// Two kinds of outcome, and the difference matters:
//
//   drop         — the finding is not real, or cannot ever be acted on: the
//                  page is a soft-404, its mapped file no longer exists, its
//                  adapter has no data for it. The caller should discard it
//                  entirely and leave it out of detectedKeys, so any already
//                  open row closes on the next sync.
//
//   blockedReason — the finding IS real and the page IS real; we just are
//                  not configured to fix it automatically yet. The caller
//                  should keep it visible, carry the reason, and let
//                  blockedRiskTier demote it to the 'manual' tier. Dropping
//                  these would report a tenant's site as healthy when the
//                  truth is that we never finished configuring their repo.
//
// The caches are per-instance and deliberately so: one repo tree read, one
// read per unique file, and one soft-404 fingerprint per pass, no matter how
// many findings share them.

export function createRecommendationGates(siteId, initialSite, deps = {}) {
  const {
    fetchTree = getRepoTree,
    fetchFile = getFileContent,
    healFn = autoHealFileMapping,
    healContentTargetFn = autoHealNewContentTarget,
    healAdapterFn = healPaginationAdapter,
    discoverRoutes = discoverPaginationRoutes,
    fetchFingerprint = fetchSoftNotFoundFingerprint,
    checkSoftNotFound = isSoftNotFound,
    designAgentStatus = getDesignAgentStatus,
    log = console,
  } = deps;

  // Reassignable: healing persists newly-discovered url_file_map entries and
  // returns the updated row, and later findings in the same pass must see
  // them — otherwise two findings on one page would each try to heal it, and
  // the second would still read the stale map.
  let site = initialSite;

  // One real read per unique data file for this whole pass, no matter how
  // many candidate pages share it (e.g. every /locations/:city/ page routes
  // through the same locations.js).
  const dataFileCache = new Map(); // `${path}@${ref}` -> file | null
  // "We could not check" is NOT the same as "it is not there", and conflating
  // them is how a revoked token or a rate limit silently empties a tenant's
  // Action Center. getFileContent already draws the line correctly — it
  // returns null only for a real 404 and throws on anything else — but a
  // `.catch(() => null)` here would throw that distinction away, so a 401
  // would read as evidence that a live page was a soft-404. Tracked
  // separately so cachedFetchFile keeps its file|null contract for
  // isDataReady, which genuinely does want "no data" for both cases.
  const unverifiableFiles = new Set(); // `${path}@${ref}`
  const cachedFetchFile = async (s, path, ref) => {
    const key = `${path}@${ref}`;
    if (dataFileCache.has(key)) return dataFileCache.get(key);
    let file = null;
    try {
      file = await fetchFile(s, path, ref);
    } catch (err) {
      unverifiableFiles.add(key);
      log.warn(`[recommendation-gates] site ${siteId}: could not verify ${path} exists (${err.message}) — not treating that as absent.`);
    }
    dataFileCache.set(key, file);
    return file;
  };

  // One design-agent-status query for this WHOLE pass, no matter how many
  // recommendations are blocked on it, and no matter which generator each
  // one is (every action type's own template is ultimately projected from
  // the SAME site-wide design-profile job — see design-drift.js's
  // persistDesignProfile — so there is exactly one real job history to ask
  // about per site, not one per actionType). Built lazily: a pass whose
  // every design check already passes never queries execution_jobs at all.
  let designAgentStatusPromise = null;
  const cachedDesignAgentStatus = (succeeded) => {
    if (!designAgentStatusPromise) designAgentStatusPromise = designAgentStatus(site, { succeeded });
    return designAgentStatusPromise;
  };

  // One repo-tree read for this whole pass no matter how many unmapped pages
  // need discovering — the tree is identical for every page on the same
  // branch, and getRepoTree costs two API calls each time.
  const treeCache = new Map(); // `${siteId}@${branch}` -> { files, truncated }
  const cachedFetchTree = async (s, branch) => {
    const key = `${s.id}@${branch}`;
    if (!treeCache.has(key)) treeCache.set(key, await fetchTree(s, branch));
    return treeCache.get(key);
  };

  // Built at most once per pass, no matter how many unmapped pages need
  // discovering — buildPermalinkIndex reads every template file's real
  // content, so without this a page after the first would pay for the same
  // repo-wide scan again. Lazy (only built the first time a page actually
  // needs it): a site whose pages all resolve some other way never pays this
  // cost at all. Reuses cachedFetchFile so a file read here and later
  // re-read by sharedTargetVeto (if it becomes the resolved candidate) is
  // fetched from GitHub only once either way.
  let permalinkIndexPromise = null;
  const cachedPermalinkIndex = async () => {
    if (!permalinkIndexPromise) {
      const branch = baseBranch(site);
      permalinkIndexPromise = cachedFetchTree(site, branch)
        .then((tree) => buildPermalinkIndex(site, tree, { fetchFile: cachedFetchFile, branch }));
    }
    return permalinkIndexPromise;
  };

  // Attempts are deduped per (page, actionType) rather than per page: whether
  // a page needs file-mapping healing at all depends on the action type,
  // because an adapter configured for one type and not another makes
  // autoHealFileMapping bail early for the former only. Keyed on page alone, a
  // page whose faq route is adapter-handled would suppress the genuine attempt
  // for its schema route.
  const healAttempted = new Set();
  const healUnmappedPage = async (pageUrl, actionType) => {
    if (!site?.repo_owner || !site?.repo_name) return;
    const key = `${pageUrl}::${actionType}`;
    if (healAttempted.has(key)) return;
    healAttempted.add(key);
    // Never fatal: this is an opportunistic upgrade of a recommendation from
    // "blocked" to "actionable". A rate-limited or unreachable repo must leave
    // the finding visible-and-blocked, not take down the whole pass.
    //
    // `routes` (this pass's already-discovered pagination families, see
    // paginationRouteFor below) is passed straight through to
    // autoHealFileMapping's own shared-target veto — it is the strongest and
    // cheapest of that veto's checks, and this is the one call site that
    // already has the routes cached.
    const healed = await healFn(site, pageUrl, actionType, {
      fetchTree: cachedFetchTree, fetchFile: cachedFetchFile, routes: paginationRoutes, permalinkIndex: cachedPermalinkIndex,
    })
      .catch((err) => {
        log.warn(`[recommendation-gates] site ${siteId}: could not auto-discover a file mapping for ${pageUrl}: ${err.message}`);
        return null;
      });
    if (healed) site = healed;
  };

  // Once per (site, actionType) for this whole pass, not once per
  // recommendation — newContentTargets is a SHARED capability: repairing it
  // once for "blog-outline" unblocks every blog-outline recommendation this
  // pass evaluates, not just the one that happened to trigger the attempt.
  const contentTargetHealAttempted = new Set();
  const healNewContentTarget = async (actionType) => {
    if (!site?.repo_owner || !site?.repo_name) return;
    if (contentTargetHealAttempted.has(actionType)) return;
    contentTargetHealAttempted.add(actionType);
    const healed = await healContentTargetFn(site, actionType, { fetchTree: cachedFetchTree })
      .catch((err) => {
        log.warn(`[recommendation-gates] site ${siteId}: could not auto-discover a content target for "${actionType}": ${err.message}`);
        return null;
      });
    if (healed) site = healed;
  };

  // Once per (route family, actionType) for this whole pass — repairing the
  // data-array-content adapter for a route family (e.g. /locations/*)
  // unblocks every sibling page this pass evaluates, not just the one that
  // happened to trigger the attempt. See pagination-adapter-discovery.js for
  // why this is safe to attempt automatically (real evidence, dry-run
  // validated before anything is persisted) despite url-file-map.js's own
  // "adapter routing is never auto-detected" rule for the general case.
  const adapterHealAttempted = new Set();
  const healPaginationRouteAdapter = async (route, actionType, pageUrl) => {
    if (!site?.repo_owner || !site?.repo_name) return;
    const key = `${route.routePrefix}::${actionType}`;
    if (adapterHealAttempted.has(key)) return;
    adapterHealAttempted.add(key);
    const healed = await healAdapterFn(site, route, actionType, pageUrl, { fetchFile: cachedFetchFile, log })
      .catch((err) => {
        log.warn(`[recommendation-gates] site ${siteId}: could not auto-configure a data-array-content adapter for ${route.routePrefix}/* (${actionType}): ${err.message}`);
        return null;
      });
    if (healed) site = healed;
  };

  // Soft-404 detection for pages we are about to report as unmapped.
  //
  // zunkireelabs.com returns its HOMEPAGE, with HTTP 200, for ANY unknown
  // path — verified against a URL invented for the test. That is an ordinary
  // static/SPA fallback, and it means a URL an agent picked up from GSC or a
  // crawl can look perfectly alive while pointing at nothing. Six such
  // /docs/* URLs were sitting in site 1's Action Center asking to be mapped
  // to a file that does not, and never will, exist.
  //
  // Reporting those as "add a url_file_map entry" is worse than dropping
  // them: it asks for work that cannot be done.
  let softNotFoundFingerprint;      // undefined = not fetched yet, null = unavailable
  let softNotFoundDiscriminates;    // guard, see below
  const softNotFoundCache = new Map();
  const isPageSoftNotFound = async (pageUrl) => {
    if (softNotFoundCache.has(pageUrl)) return softNotFoundCache.get(pageUrl);
    if (softNotFoundFingerprint === undefined) {
      let origin = null;
      try { origin = new URL(pageUrl).origin; } catch { origin = null; }
      softNotFoundFingerprint = origin ? await fetchFingerprint(origin).catch(() => null) : null;

      // A genuinely client-rendered SPA serves the same shell for EVERY
      // route, real or not, so the fingerprint would match real pages too and
      // this check would delete the entire Action Center. Prove it
      // discriminates first, using a page this site has a real file mapping
      // for — if even that looks like the 404 fallback, the signal is
      // meaningless here and is abandoned rather than trusted.
      const known = Object.keys(site?.url_file_map?.pages || {})[0];
      if (softNotFoundFingerprint && known) {
        let knownUrl = null;
        try { knownUrl = new URL(known, new URL(pageUrl).origin).href; } catch { knownUrl = null; }
        softNotFoundDiscriminates = knownUrl
          ? !(await checkSoftNotFound(knownUrl, softNotFoundFingerprint).catch(() => true))
          : false;
        if (!softNotFoundDiscriminates) {
          log.warn(`[recommendation-gates] site ${siteId}: a known-real page matches the 404 fallback fingerprint — treating the soft-404 signal as unusable for this site.`);
        }
      } else {
        softNotFoundDiscriminates = false;
      }
    }
    if (!softNotFoundFingerprint || !softNotFoundDiscriminates) return false;
    const result = await checkSoftNotFound(pageUrl, softNotFoundFingerprint).catch(() => false);
    if (result) log.log(`[recommendation-gates] site ${siteId}: ${pageUrl} renders the site's 404 fallback — dropping its recommendation instead of asking for a file mapping.`);
    softNotFoundCache.set(pageUrl, result);
    return result;
  };

  // Generated-page detection, so an unmappable URL gets an accurate reason
  // instead of "add a url_file_map entry" — see implementers/lib/pagination-routes.js.
  // Discovered once per pass (a repo-tree read plus one fetch per paginating
  // template) and only when something is actually about to be reported unmapped.
  let paginationRoutes;
  const paginationRouteFor = async (pageUrl) => {
    if (paginationRoutes === undefined) {
      paginationRoutes = await discoverRoutes(site, { fetchTree: cachedFetchTree })
        .catch((err) => {
          log.warn(`[recommendation-gates] site ${siteId}: could not scan for generated routes: ${err.message}`);
          return [];
        });
      if (paginationRoutes.length) {
        log.log(`[recommendation-gates] site ${siteId}: found ${paginationRoutes.length} generated route family(ies): ${paginationRoutes.map((r) => r.routePrefix + '/*').join(', ')}`);
      }
    }
    return matchPaginationRoute(pageUrl, paginationRoutes);
  };

  // Runs every gate for one candidate, in the order that produces the most
  // useful answer: cheap config checks first, network evidence only when
  // something is actually about to be reported.
  async function evaluate(generatorId, params) {
    if (!site) return { drop: null, blockedReason: null };
    const page = params?.page;

    // The net-new counterpart of the page-mapping gate. Net-new content
    // (blog-outline, direct-answer, landing-page, the legal pages) has no
    // params.page to map — it resolves its destination through
    // url_file_map.newContentTargets instead, and frontend.js hard-fails with
    // 'no-file-mapping' at apply time when that entry is absent.
    //
    // This is what makes promoting blog-outline to the safe tier honest for
    // EVERY tenant rather than just the one that happens to be configured.
    //
    // Deliberately checks only the target's existence. The second
    // prerequisite for markdown content — a renderCapabilities entry proving
    // the extension gets a markdown pass — is enforced by rendering-gate.js's
    // validateRenderingBatch inside pushDraftBranch, which fails closed and is
    // the single choke point every implementer funnels through. Duplicating
    // that rule here would give it two definitions that could disagree.
    //
    // Missing target -> attempt the shared capability repair (once per
    // actionType this pass, see healNewContentTarget) -> re-check. Same
    // "classify, heal, re-check" shape as the page-mapping gate below.
    let mappingBlockedReason = null;
    if (FRONTEND_ACTION_TYPES.has(generatorId) && !resolveNewContentTarget(site, generatorId, 'probe')) {
      await healNewContentTarget(generatorId);
    }
    if (FRONTEND_ACTION_TYPES.has(generatorId) && !resolveNewContentTarget(site, generatorId, 'probe')) {
      mappingBlockedReason = `No url_file_map.newContentTargets["${generatorId}"] is configured for this site, so there is nowhere in the repo to create the new file. Add one (e.g. {"dir":"src/blog","extension":".md"}) via 'npm run connect-repo' before this can be applied.`;
    }

    // broken-link-fix is excluded from every page gate below:
    // computeBrokenLinkFixMerge (backend.js) has its own GitHub code-search
    // fallback for exactly the pages these checks would flag, so "not in
    // url_file_map" isn't fatal for it the way it is for every other
    // generatorId.
    const pageGated = generatorId !== 'broken-link-fix' && !!page;

    if (pageGated && !isPageMapped(site, page, generatorId)) {
      // Classify BEFORE attempting to heal, not after. Healing is a write
      // (autoHealFileMapping persists a url_file_map entry); asking "is this
      // page a known generated-route family" first means a page that is
      // genuinely a shared-template instance gets diagnosed as one — and its
      // recommendation gets the true reason immediately — without ever
      // depending on healing's own veto to reject a candidate match by luck.
      // The two are not fully redundant: healUnmappedPage's own veto (via
      // sharedTargetVeto) still applies for candidates this pass's route scan
      // did not discover (e.g. the repo scan failed this run), so it stays as
      // the second line of defense, not a decision this branch second-guesses.
      const generated = await paginationRouteFor(page);
      if (generated) {
        // canonical/open-graph are the one case where "there is no per-page
        // file to map" doesn't mean "blocked" — the value is derivable from
        // the page's own url/title/description, which the layout already
        // has for every generated page by construction, so real evidence
        // (not a guess) can prove no fix is even needed. See
        // paginationHeadTagAutoHandled's own comment for why this is safe
        // to drop rather than merely reclassify.
        if (await paginationHeadTagAutoHandled(site, generated, generatorId, { fetchFile: cachedFetchFile, fetchTree: cachedFetchTree })) {
          return { drop: 'auto-computed-by-layout', blockedReason: null };
        }
        // Try to self-heal the missing route BEFORE reporting it blocked —
        // same "classify, heal, re-check" shape as healUnmappedPage below,
        // one layer deeper (a data-array adapter route, not a plain file).
        if (!isPageMapped(site, page, generatorId)) {
          await healPaginationRouteAdapter(generated, generatorId, page);
        }
        if (!isPageMapped(site, page, generatorId)) {
          mappingBlockedReason = paginationBlockedReason(generated, generatorId);
        }
      } else {
        await healUnmappedPage(page, generatorId);
        if (!isPageMapped(site, page, generatorId)) {
          // Before asking anyone to map it, make sure the page is real.
          if (await isPageSoftNotFound(page)) return { drop: 'soft-404', blockedReason: null };
          mappingBlockedReason = `No url_file_map entry resolves ${page} to a file in this site's repo, and it could not be discovered automatically. Add a mapping via 'npm run connect-repo' (or 'npm run audit-url-file-map -- --site-id <id>' to see every gap) before this can be applied.`;
        }
      }
    }

    // isPageMapped only proves url_file_map SYNTACTICALLY resolves a path (an
    // exact `pages[]` entry, or a `patterns[]` regex match) — it never
    // confirms that resolved file genuinely exists in the repo. A generic
    // catch-all pattern (e.g. `^/([a-z0-9-]+)/?$` -> "src/pages/$1.njk")
    // matches any URL that merely LOOKS like a real page, and many static-site
    // nginx configs make that trivially true for URLs that were never real.
    // Real incident: zunkireelabs.com/ai-agents/ (a soft-404 — no template
    // anywhere sets that permalink) matched the generic pattern to a
    // nonexistent src/pages/ai-agents.njk, and the resulting recommendation
    // showed "SAFE — AUTO-ELIGIBLE" right up until someone approved it.
    //
    // Drop ONLY on a definitive 404. If the read failed for any other reason
    // we have no evidence either way, and dropping would repeat the very bug
    // this gate exists to prevent — inventing a conclusion from an unverified
    // guess, just in the opposite direction.
    if (pageGated) {
      const filePath = resolveFile(site, page);
      if (filePath) {
        const ref = baseBranch(site);
        const exists = await cachedFetchFile(site, filePath, ref);
        if (!exists && !unverifiableFiles.has(`${filePath}@${ref}`)) return { drop: 'file-missing', blockedReason: null };
      }
    }

    // isPageMapped only confirms a ROUTE exists (a file, or an adapter
    // configured for this actionType) — for data-array-content specifically,
    // that route can be configured while the adapter's own data still has
    // nothing for this exact page (e.g. a location with no
    // `services.web-development` entry yet). Checked here, not just inside the
    // adapter's own apply(), so a recommendation that can never actually apply
    // stops resurfacing every refresh.
    if (pageGated) {
      const adapterConfig = resolveAdapter(site, page, generatorId);
      if (adapterConfig?.id === 'data-array-content'
        && !(await isDataReady(site, page, adapterConfig, cachedFetchFile, baseBranch(site)))) {
        return { drop: 'adapter-data-not-ready', blockedReason: null };
      }
    }

    // Design-verification gate. Like the url_file_map gate above (and unlike
    // the gates that drop), this one does NOT drop — a blocked item is a real,
    // correctly-detected issue we simply aren't allowed to auto-fix yet, so
    // dropping it would lose a genuine finding and let the recommendation
    // close out as "resolved" when nothing was resolved. The real hard block
    // (a 422) lives in generateDraft — this is the honest UI half of it, so a
    // user sees "blocked, here's why" instead of clicking Generate and getting
    // an error. Pure in-memory check against the already-loaded `site` row.
    const designCheck = componentTemplateVerification(site, componentTemplateActionTypeFor(generatorId));

    // Enrich a blocked design-check with the REAL, persisted Design Agent
    // job status (implementers/lib/design-agent-status.js) instead of
    // componentTemplateVerification's static "queued, no action needed"
    // text — that text is deliberately generic (it's also read on
    // generateDraft's HOT path in routes/action-center.js, where a DB query
    // per call would be a real cost, see that function's own "safe on the
    // hot path" comment), but THIS pass already does several other DB/
    // network reads per site and is exactly where an honest, job-aware
    // message belongs. Every actionType's own template is ultimately
    // projected from the SAME site-wide design-profile job (see
    // design-drift.js's persistDesignProfile), so one status lookup per
    // site per pass covers every blocked recommendation regardless of
    // generatorId — see cachedDesignAgentStatus above.
    //
    // Only attempted when the Design Agent could actually run for this site
    // (same gate resolveOrCreateComponentTemplate itself checks) — a site
    // that hasn't had its one-time auto-remediation review, or has no repo
    // connected, will never have a job to ask about, and querying would
    // only produce a misleading "never_attempted... will unblock
    // automatically"-flavored message for a site where nothing is ever
    // going to run automatically at all.
    let designBlockedReason = designCheck.ok ? null : designCheck.detail;
    if (!designCheck.ok && site.auto_remediation_enabled && site.repo_owner && site.repo_name) {
      const status = await cachedDesignAgentStatus(false).catch((err) => {
        log.warn(`[recommendation-gates] site ${siteId}: could not read Design Agent status: ${err.message}`);
        return null;
      });
      if (status) designBlockedReason = status.detail;
    }

    // Both blockers land in one field. The reason text says which one it was,
    // and nothing downstream needs to branch on the kind — blockedRiskTier
    // only checks truthiness. The mapping block is reported first when both
    // apply, because it's the more fundamental one: there is no point telling
    // someone to verify a component template for a page we can't locate a file
    // for.
    return { drop: null, blockedReason: mappingBlockedReason || designBlockedReason };
  }

  return {
    evaluate,
    // The caches are shared with buildRecommendations, which needs the same
    // repo reads for its own purposes — exposing them keeps the pass to one
    // read per file/tree rather than two parallel sets of caches.
    get site() { return site; },
    cachedFetchFile,
    cachedFetchTree,
    isPageSoftNotFound,
    paginationRouteFor,
  };
}
