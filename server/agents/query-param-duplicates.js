import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';

export const meta = {
  id: 'query-param-duplicates',
  name: 'Query-Param Faceted URL Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs by their base path (query string stripped) and flags when two or more DIFFERENT query-string variants of the same page are all separately known/crawlable — a common cause of faceted-navigation URLs (sort, filter, tracking params) being indexed as competing duplicates instead of consolidating onto the base page.',
  category: 'technical',
  version: 1,
};

// No LLM, no live fetch — a normalize-and-group pass over page_inventory,
// same shape and cost profile as url-variant-duplicates.js.
function baseKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return String(pageUrl).split('?')[0];
  }
}

function hasQuery(pageUrl) {
  try { return new URL(pageUrl).search.length > 0; } catch { return pageUrl.includes('?'); }
}

// A single query-string variant alongside its base page is normal
// (a legitimate filter/sort link) — this only fires once at least two
// DIFFERENT query-string combinations of the same page are both known,
// which is the actual duplication risk (multiple separately-indexable
// facet combinations, not just one optional parameter existing).
const MIN_QUERY_VARIANTS = 2;

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Site not found.', generatedAt: new Date().toISOString(),
    };
  }

  const inventory = await listPageInventory(siteId, { limit: 2000 });
  const live = inventory.filter((r) => !r.orphaned);
  if (!live.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page inventory recorded yet for this site.', generatedAt: new Date().toISOString(),
    };
  }

  const groups = new Map(); // baseKey -> Set<rawPage>
  for (const row of live) {
    const key = baseKey(row.page);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.page);
  }

  const findings = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, pagesSet]) => {
      const pages = [...pagesSet].sort();
      const queryVariants = pages.filter(hasQuery);
      if (queryVariants.length < MIN_QUERY_VARIANTS) return [];
      const basePage = pages.find((p) => !hasQuery(p)) || pages[0];
      return [makeFinding({
        id: `query-param-duplicates:key:${key}`,
        evidence: { basePath: key, variants: pages },
        whyItMatters: `${queryVariants.length} different query-string variants of the same page (${key}) are all separately known/crawlable — unless each one carries a canonical tag pointing back at the base URL, Google can index them as separate, competing pages instead of one.`,
        priority: 'medium',
        // Whether these variants already canonicalize correctly (working
        // faceted navigation) or are a real duplication problem needs a
        // human to confirm — this only flags that the variants exist, same
        // stance as url-variant-duplicates.js.
        recommendedAction: null,
        reportOnly: {
          kind: 'query-param-duplicate',
          label: `${queryVariants.length} query-param variants of the same page`,
          page: basePage,
          whyBlocked: 'Confirming whether these variants already canonicalize correctly, or need a canonical tag added, needs a person to check the live pages — this only flags that the variants exist.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
      })];
    });

  const facts = { checkedCount: live.length, groupsWithQueryVariants: findings.length, findings };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} page(s) have multiple query-param variants that may be indexing as duplicates.` : null,
    generatedAt: new Date().toISOString(),
  };
}
