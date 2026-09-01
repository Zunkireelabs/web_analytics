import { getSearchPerformanceRange, getSearchPerformanceForPages, getSiteById } from '../../store/read.js';
import { listPageInventory } from '../../store/page-inventory.js';
import { getCheckedAtForPages as getCheckedAtForPagesDefault, markPagesChecked } from '../../store/agent-page-rotation.js';
import { sortByRotation } from './rotation.js';
import { knownDomain, filterOwnDomainPages } from './site-domain.js';
// Already exported and already proven against this exact failure — see the
// SOFT-404 block below for why it was never applied here until now.
import { fetchSoftNotFoundFingerprint, isSoftNotFound } from './technical-seo-analysis.js';

const DEFAULT_GSC_LIMIT = 100;
const DEFAULT_ZERO_TRAFFIC_LIMIT = 200;
const DEFAULT_BATCH_SIZE = 20;
// At least a quarter of every batch is reserved for zero-traffic pages
// (site_pages entries with no real GSC impressions), even on a site with
// plenty of GSC-known pages — otherwise a popular site (exactly the kind
// large enough for this to matter) would let its GSC pool always fill the
// whole batch, and a zero-traffic page would never get checked. GSC-known
// pages still get the majority share and go first within their own slice,
// protecting quota-limited downstream calls (technical-seo's GSC URL
// Inspection API specifically) by prioritizing already-important pages.
const ZERO_TRAFFIC_SHARE = 0.25;

// ─────────────────────────────────────────────────────────────────────────
// SOFT-404 / CATCH-ALL FILTERING
//
// A 200 status does not prove a page exists. zunkireelabs.com serves its
// homepage, byte-for-byte, for ANY unmatched path — /gaas/ and
// /zzz-not-a-page/ both return 200 with the homepage. Sitemap and crawl
// discovery feed those URLs into page_inventory, and from there straight to
// every page-level agent, which dutifully finds "missing question-style
// headings" on a page that does not exist. The resulting recommendations can
// never be fixed: /gaas/ failed 9 times before the convergence cap held it.
//
// Nothing filtered a candidate URL before analysis — the only pre-fetch check
// was domain matching. The detection itself already existed and is already
// exported (technical-seo-analysis.js, whose own comment describes "a
// static-host/SPA catch-all misconfig confirmed on at least one real site
// this codebase tracks" — this site); it was simply never applied to the page
// list agents actually scan. This wires it in at that one shared choke point,
// so every agent inherits it at once.
//
// Two guardrails, both load-bearing:
//   - A fully client-rendered site legitimately serves one shell for every
//     route, real or not. There the fingerprint matches everything, so a high
//     match rate across a real sample DISABLES the filter for that run rather
//     than deleting the site's whole page list. Same reasoning, and the same
//     numbers, as technical-seo-analysis.js's own crawl bailout.
//   - No fingerprint (fetch failed, private host) means no filtering at all.
//     This is additive; it must never be the reason a real page goes
//     unanalyzed.
const SOFT_404_MIN_SAMPLE = 5;
const SOFT_404_BAILOUT_RATIO = 0.5;

// One fingerprint + verdict set per site, reused across every agent in a cron
// pass. Without this each of the ~12 page-level agents would re-fetch the
// same fingerprint and re-test the same URLs — the filter would cost more
// requests than the phantom pages it saves. The TTL is deliberately shorter
// than a day so a site that fixes its catch-all isn't held to a stale verdict.
const SOFT_404_CACHE_TTL_MS = 15 * 60 * 1000;
// orchestrator.js runs a site's page-level agents concurrently via
// Promise.all (agents/orchestrator.js:92); every one of them calls
// selectCandidatePages for the same siteId in the same tick. Caching only the
// RESOLVED fingerprint/verdict (not the Promise) let every concurrent caller
// see `undefined` before the first fetch settled and each issue its own
// duplicate request — the exact redundant-request cost this cache exists to
// prevent, defeated by the concurrency pattern already used to reach it.
// createPageCache() (fetch-cache.js) already solved this correctly for page
// fetches: cache the in-flight Promise itself, synchronously, before any
// await — every concurrent caller then awaits the SAME promise instead of
// starting a new fetch. Reused here rather than reinvented.
const softNotFoundCache = new Map(); // siteId -> { at, fingerprint: Promise, verdicts: Map<url, Promise<boolean>> }

// Sites are added here on every real call and never removed on their own —
// left unbounded, a growing multi-tenant fleet with site churn accumulates
// one entry per site ever scanned for the life of the process. Piggybacks
// eviction on the read path (a per-site TTL check already runs on every
// call) rather than a separate timer, and only when the map has actually
// grown past a real fleet's size — so this costs nothing on every call, only
// once every SWEEP_INTERVAL calls once there's something worth sweeping.
const MAX_TRACKED_SITES = 500;
const SWEEP_INTERVAL_CALLS = 50;
let callsSinceSweep = 0;

function sweepExpiredEntries() {
  const now = Date.now();
  for (const [siteId, entry] of softNotFoundCache) {
    if (now - entry.at >= SOFT_404_CACHE_TTL_MS) softNotFoundCache.delete(siteId);
  }
}

function cacheFor(siteId) {
  const hit = softNotFoundCache.get(siteId);
  if (hit && Date.now() - hit.at < SOFT_404_CACHE_TTL_MS) return hit;
  if (softNotFoundCache.size >= MAX_TRACKED_SITES && ++callsSinceSweep >= SWEEP_INTERVAL_CALLS) {
    callsSinceSweep = 0;
    sweepExpiredEntries();
  }
  const fresh = { at: Date.now(), fingerprint: undefined, verdicts: new Map() };
  softNotFoundCache.set(siteId, fresh);
  return fresh;
}

// Exported for tests and for any future caller that needs the same judgement.
export function clearSoftNotFoundCache(siteId = null) {
  if (siteId == null) softNotFoundCache.clear();
  else softNotFoundCache.delete(siteId);
}

/**
 * Drops pages that render this site's "nothing here" response.
 * @returns {{pages: string[], dropped: string[]}} — `dropped` is returned
 * rather than only logged so a caller can report it honestly.
 */
export async function filterSoftNotFoundPages(siteId, pages, {
  fetchFingerprint = fetchSoftNotFoundFingerprint,
  checkSoftNotFound = isSoftNotFound,
} = {}) {
  if (!pages.length) return { pages, dropped: [] };
  const origin = (() => { try { return new URL(pages[0]).origin; } catch { return null; } })();
  if (!origin) return { pages, dropped: [] };

  const cache = cacheFor(siteId);
  // Store the PROMISE synchronously, before any await — every caller in this
  // tick (the ~12 agents Promise.all-ed together per site) sees the same
  // in-flight promise and awaits it, instead of each racing to start its own
  // fetch. See createPageCache (fetch-cache.js) for the identical pattern.
  if (cache.fingerprint === undefined) cache.fingerprint = fetchFingerprint(origin);
  const fingerprint = await cache.fingerprint;
  if (!fingerprint) return { pages, dropped: [] };

  const verdicts = await Promise.all(pages.map((url) => {
    if (!cache.verdicts.has(url)) cache.verdicts.set(url, checkSoftNotFound(url, fingerprint));
    return cache.verdicts.get(url);
  }));

  const dropped = pages.filter((_, i) => verdicts[i]);
  // The discrimination guard. If most of a real sample looks like the
  // "nothing here" page, the signal isn't telling real from fake on this
  // site — trust the pages, not the heuristic.
  if (pages.length >= SOFT_404_MIN_SAMPLE && dropped.length / pages.length > SOFT_404_BAILOUT_RATIO) {
    console.warn(`[candidate-pages] site ${siteId}: soft-404 signal matched ${dropped.length}/${pages.length} candidates — treating it as unreliable and analyzing all of them.`);
    return { pages, dropped: [] };
  }
  return { pages: pages.filter((_, i) => !verdicts[i]), dropped };
}

// Merges GSC's real top pages (the existing, highest-priority signal) with
// the site-wide page_inventory (sitemap+crawl-discovered pages that may
// have zero search traffic yet), then applies the same bounded-rotation
// philosophy technical-seo-analysis.js proved — so a page-level agent sees
// the whole site over time, not just whatever already has GSC traffic,
// without checking hundreds of pages in a single run.
// `getCheckedAtForPages` defaults to the shared agent_page_rotation table
// (server/store/agent-page-rotation.js) — the right choice for any agent
// that previously had zero per-page persistence (ai-visibility, content-gap).
// technical-seo.js already has its own rotation ledger (technical_seo_checks,
// migration 026) and injects an adapter over that instead, so it gets one
// rotation table per agent, not two competing ones.
export async function selectCandidatePages(siteId, agentId, {
  start, end, gscLimit = DEFAULT_GSC_LIMIT, zeroTrafficLimit = DEFAULT_ZERO_TRAFFIC_LIMIT, batchSize = DEFAULT_BATCH_SIZE,
  getCheckedAtForPages = getCheckedAtForPagesDefault,
  filterSoftNotFound = filterSoftNotFoundPages,
  markPagesCheckedFn = markPagesChecked,
} = {}) {
  const [site, gscPagesRaw, inventoryRaw] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', gscLimit),
    listPageInventory(siteId, { limit: zeroTrafficLimit + gscLimit }),
  ]);
  // knownDomain (primary website_domain only), NOT ownDomains — this is the
  // page pool every finding-generating agent scans to CREATE recommendations
  // from, and a site's additional_own_domains (e.g. Zunkiree Labs' edgex./
  // zenly.zunkireelabs.com — separate products on their own subdomain, see
  // migration 123) are registered for OTHER purposes (not being treated as
  // foreign by the resolution/repair layer — see url-file-map.js's
  // resolveHostScope) without being in scope for THIS site's own Action
  // Center. Confirmed 2026-08-24: scanning ownDomains here is what let
  // edgex.zunkireelabs.com pages generate real recommendations at all.
  const domain = knownDomain(site);
  const gscPages = filterOwnDomainPages(gscPagesRaw, domain);
  const inventory = filterOwnDomainPages(inventoryRaw, domain, (r) => r.page);

  const impressionsByPage = new Map(gscPages.map((p) => [p.dim_value, Number(p.impressions)]));
  const gscUrls = gscPages.map((p) => p.dim_value);
  const zeroTrafficUrls = inventory.map((r) => r.page).filter((page) => !impressionsByPage.has(page)).slice(0, zeroTrafficLimit);

  const checkedAt = await getCheckedAtForPages(siteId, agentId, [...gscUrls, ...zeroTrafficUrls]);
  const gscSorted = sortByRotation(gscUrls, checkedAt);
  const zeroTrafficSorted = sortByRotation(zeroTrafficUrls, checkedAt);

  const zeroTrafficSlots = Math.max(1, Math.round(batchSize * ZERO_TRAFFIC_SHARE));
  let batch = [...gscSorted.slice(0, batchSize - zeroTrafficSlots), ...zeroTrafficSorted.slice(0, zeroTrafficSlots)];

  // Either pool can be smaller than its reserved share (e.g. a brand-new
  // site with few GSC pages, or a site whose crawl hasn't found much yet)
  // — top up from whichever pool still has candidates left rather than
  // wasting the unused slots.
  if (batch.length < batchSize) {
    const used = new Set(batch);
    const leftover = [...gscSorted, ...zeroTrafficSorted].filter((p) => !used.has(p));
    batch = [...batch, ...leftover].slice(0, batchSize);
  }

  // Drop candidates that are this site's catch-all "nothing here" response
  // before any agent analyzes them. Applied to the BATCH rather than the whole
  // pool: the pool can be hundreds of URLs and each verdict costs a real
  // request, while the batch is what actually gets analyzed this run. Pages
  // dropped here stay in page_inventory and simply aren't scanned — nothing is
  // deleted on the strength of a heuristic.
  const beforeFilter = batch.length;
  const { pages: realPages, dropped } = await filterSoftNotFound(siteId, batch);
  if (dropped.length) {
    console.log(`[candidate-pages] site ${siteId} (${agentId}): skipping ${dropped.length}/${beforeFilter} candidate(s) that render this site's catch-all page, not a real page: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ''}`);
    // Mark the phantom itself checked, right here, rather than leaving that to
    // callers — every caller below marks only the RETURNED `batch`, which by
    // definition no longer contains a dropped page. Left unmarked, a phantom's
    // rotation timestamp never updates, sortByRotation keeps ranking it as
    // "never checked" forever, and it re-wins a batch slot — and gets
    // soft-404-checked again — on every single future run, permanently
    // starving a real never-checked page out of that slot instead of the
    // one-time skip this filter was meant to provide.
    await markPagesCheckedFn(siteId, agentId, dropped).catch((err) => {
      console.error(`[candidate-pages] site ${siteId} (${agentId}): could not mark ${dropped.length} phantom page(s) checked:`, err.message);
    });
  }
  batch = realPages;

  // A page in the batch that's "not in impressionsByPage" only means it
  // wasn't in the top `gscLimit` pages by traffic — on a site with more
  // than `gscLimit` actively-trafficked pages, that's a real, nonzero page
  // wrongly reported as "0 impressions" downstream. Fetch the true number
  // for just the (small, batch-bounded) pages that need it — a genuinely
  // zero-traffic page simply won't appear in the result, so the `|| 0`
  // fallback callers already use stays correct for that case.
  const needsRealImpressions = batch.filter((p) => !impressionsByPage.has(p));
  if (needsRealImpressions.length) {
    const real = await getSearchPerformanceForPages(siteId, start, end, needsRealImpressions);
    for (const row of real) impressionsByPage.set(row.dim_value, Number(row.impressions));
  }

  return { batch, impressionsByPage };
}

export { markPagesChecked };
