import { getSearchPerformanceRange, getSearchPerformanceForPages, getSiteById } from '../../store/read.js';
import { listPageInventory } from '../../store/page-inventory.js';
import { getCheckedAtForPages as getCheckedAtForPagesDefault, markPagesChecked } from '../../store/agent-page-rotation.js';
import { sortByRotation } from './rotation.js';
import { knownDomain, filterOwnDomainPages } from './site-domain.js';

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
