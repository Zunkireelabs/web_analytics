import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';

export const meta = {
  id: 'url-variant-duplicates',
  name: 'URL Variant Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs (crawl/sitemap/GSC) by a normalized key — trailing slash, case, and percent-encoding stripped — and flags when two structurally different URLs both resolve to the same page. A common, silent cause of Search Console duplicate/canonical-conflict reports that a byte-content hash check (duplicate-content.js) can miss whenever only one of the two variants ever actually got crawled.',
  category: 'technical',
  version: 1,
};

// No LLM, no live fetch — purely a normalize-and-group pass over data this
// platform already collected for other reasons (page_inventory), so this
// check keeps working even during an LLM outage and costs nothing extra to
// run daily.
function normalizeKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    let path = decodeURIComponent(u.pathname).toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return String(pageUrl).toLowerCase();
  }
}

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

  const groups = new Map(); // normalizedKey -> Set<rawPage>
  for (const row of live) {
    const key = normalizeKey(row.page);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.page);
  }

  const dupGroups = [...groups.entries()].filter(([, pages]) => pages.size > 1);
  if (!dupGroups.length) {
    return {
      meta, status: 'ok',
      facts: { checkedCount: live.length, groupsWithDuplicates: 0, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const findings = dupGroups
    .sort((a, b) => a[0].localeCompare(b[0])) // stable run-to-run order
    .map(([key, pagesSet]) => {
      const pages = [...pagesSet].sort();
      return makeFinding({
        id: `url-variant-duplicates:key:${key}`,
        evidence: { normalizedKey: key, variants: pages },
        whyItMatters: `${pages.length} different URLs (${pages.join(', ')}) all resolve to the same page once trailing slash, case, and encoding are normalized — Google can index these as separate, competing URLs instead of recognizing them as one.`,
        priority: 'medium',
        // Which exact variant is the site's real canonical form is a real
        // decision (matches the site's own established URL convention, not
        // derivable from inventory rows alone) — guessing wrong here would
        // redirect the site's real, working URL to a placeholder. Same
        // stance as duplicate-content.js's byte-identical groups.
        recommendedAction: null,
        reportOnly: {
          kind: 'url-variant-duplicate',
          label: `${pages.length} URL variants of the same page`,
          page: pages[0],
          whyBlocked: 'Picking which exact variant (trailing slash, casing, encoding) is the site\'s real canonical form, and redirecting/canonicalizing the others to it, needs a human to confirm which one is intended.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
      });
    });

  const facts = { checkedCount: live.length, groupsWithDuplicates: dupGroups.length, findings };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} group(s) of URL variants (trailing slash/case/encoding) found for the same underlying page.` : null,
    generatedAt: new Date().toISOString(),
  };
}
