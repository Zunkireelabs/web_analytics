import { discoverFromSitemaps } from '../agents/lib/site-discovery.js';
import { listPageInventory, upsertPageInventoryBatch } from '../store/page-inventory.js';
import { listSitemaps, submitSitemap } from '../ingest/gsc-technical.js';

// DAILY SITEMAP SYNC. Page discovery (job.js runSiteDiscoveryIfDue) crawls the whole site and only runs about once a week, and its
// "is it due" check can skip a week outright, so a page that is published right after one run can wait up to ~2 weeks before anything
// looks at it (zunkireelabs: 17 of its newest posts, all in the live sitemap, were missing from the inventory six days after the last run).
//
// This is the cheap part of discovery done every day: read the sitemap(s) the site already publishes and add any URL the inventory does
// not have yet. A new page is then picked up by the agents' rotation like any other inventoried page (technical SEO inspects its Google
// index status first, because it has never been checked).
//
// What it never does: crawl, prune, or touch the orphaned flag. Those need a complete crawl and stay with the weekly run. A site whose
// sitemap cannot be read (empty or failing) is skipped, so a bad fetch can never remove or mislabel anything.
//
// If anything new was found it also asks Search Console to re-read the site's registered sitemap, so Google learns about the new
// pages sooner. That is the only "indexing" lever Google offers for ordinary pages (its Indexing API is for job postings and
// livestreams only). Best-effort: a connection without write access reports why and nothing else changes.

const normalize = (u) => String(u || '').replace(/\/+$/, '');

async function resubmitRegisteredSitemap(site) {
  if (!site.gsc_property) return { skipped: true, reason: 'no-gsc-property' };
  const sitemaps = await listSitemaps(site);
  if (!sitemaps.ok || !sitemaps.sitemaps?.length) return { ok: false, reason: 'no-sitemap-registered', error: sitemaps.error || 'No sitemap is registered in Search Console for this property yet.' };
  return submitSitemap(site, sitemaps.sitemaps[0].path);
}

/**
 * One site. Returns { added, newPages, sitemapResubmit } or { added: 0, skipped } when there was nothing safe to do.
 * Every collaborator is injectable so this is tested without a database, the network or Google.
 */
export async function syncSitemapIntoInventory(site, {
  discover = discoverFromSitemaps,
  listInventory = listPageInventory,
  upsert = upsertPageInventoryBatch,
  resubmit = resubmitRegisteredSitemap,
} = {}) {
  let sitemapUrls;
  try { sitemapUrls = await discover(site); } catch { return { added: 0, skipped: 'sitemap-unreadable' }; }
  if (!Array.isArray(sitemapUrls) || sitemapUrls.length === 0) return { added: 0, skipped: 'no-sitemap-urls' };

  const known = new Set((await listInventory(site.id, { limit: 100000 })).map((r) => normalize(r.page)));
  const fresh = [...new Map(sitemapUrls.map((u) => [normalize(u), u])).entries()].filter(([key]) => !known.has(key)).map(([, u]) => u);
  if (!fresh.length) return { added: 0, newPages: [] };

  await upsert(site.id, fresh, 'sitemap');
  const sitemapResubmit = await resubmit(site).catch((err) => ({ ok: false, reason: 'resubmit-failed', error: String(err?.message || err).slice(0, 160) }));
  return { added: fresh.length, newPages: fresh.slice(0, 50), sitemapResubmit };
}
