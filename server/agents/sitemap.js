import { getSiteById } from '../store/read.js';
import { listPageInventory, listOrphanedPages } from '../store/page-inventory.js';
import { discoverSitemapEntries } from './lib/site-discovery.js';
import { computeMissingUrls, buildMissingUrlsFinding } from './lib/sitemap-diff.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'sitemap',
  name: 'Sitemap Agent',
  description: 'Compares this site\'s already-discovered pages (crawl/GSC/sitemap) against its live sitemap.xml and flags real URLs missing from it.',
  category: 'technical',
  version: 1,
};

// Opt-in only — this platform never touches a sitemap file for a tenant
// that hasn't explicitly mapped one (see server/implementers/types.js's
// sitemap comment: most tenants' own build regenerates their sitemap on
// every deploy, so guessing a path here would fight that build). Absence of
// the mapping is an honest "not enabled for this site" outcome, never a
// guessed default path.
export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  const sitemapPath = site?.url_file_map?.siteRoot?.sitemap;
  if (!sitemapPath) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No sitemap mapped yet for this site — set url_file_map.siteRoot.sitemap (via `npm run connect-repo`) to enable sitemap monitoring.',
      generatedAt: new Date().toISOString(),
    };
  }

  // Real, already-collected data — no new crawl/fetch beyond one live
  // sitemap read: page_inventory is the existing weekly sitemap+crawl+GSC
  // superset (job.js's runSiteDiscoveryIfDue), and listOrphanedPages is the
  // same real orphan signal technical-seo.js already surfaces, reused here
  // rather than re-detected.
  const [inventory, sitemapEntries, orphanedPages] = await Promise.all([
    listPageInventory(siteId),
    discoverSitemapEntries(site),
    listOrphanedPages(siteId),
  ]);

  const missingUrls = computeMissingUrls(inventory.map((r) => r.page), sitemapEntries);
  const orphanedUrls = orphanedPages.map((p) => p.page);

  if (!missingUrls.length) {
    return {
      meta, status: 'ok',
      facts: { sitemapPath, missingUrls: [], missingCount: 0, orphanedUrls, orphanedCount: orphanedUrls.length, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  // One aggregated finding for the whole site, not one per missing URL — a
  // real sitemap update is one file change regardless of how many URLs are
  // missing, same "one finding per shared root cause" convention as
  // security-headers.js's site-wide missing-headers finding.
  const finding = buildMissingUrlsFinding({ sitemapPath, missingUrls, orphanedUrls });
  const facts = {
    sitemapPath, missingUrls, missingCount: missingUrls.length,
    orphanedUrls, orphanedCount: orphanedUrls.length,
    findings: [finding],
  };

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given a real, ' +
    'computed list of URLs missing from a site\'s sitemap.xml (and, if present, URLs already in the sitemap that ' +
    'a real crawl could not reach), write 2-3 sentences explaining why keeping the sitemap current matters and ' +
    'one concrete next step. Use ONLY the numbers given, never invent a URL or count not present in the facts. ' +
    'Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
    .catch((err) => { console.warn('[agents] sitemap narrative failed:', err.message); return finding.whyItMatters; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
