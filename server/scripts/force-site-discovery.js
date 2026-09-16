#!/usr/bin/env node
// One-time catch-up for page_inventory, same reasoning as
// force-design-profile-rescan.js: runSiteDiscoveryIfDueForAllSites only
// re-crawls/re-fetches a site's sitemap once a week, which is correct for
// routine drift-detection but means page_inventory can sit stale even when
// the site's OWN sitemap has changed since the last run — confirmed on
// chayceproperties.com, whose real sitemap.xml lists /news/, but every
// stored page_inventory row is tagged 'crawl', never 'sitemap': that fetch
// never successfully landed a result, so /news/ has stayed invisible to
// every page-level agent (selectCandidatePages) regardless of how long it
// waits, since the weekly gate only asks "did we run recently."
//
// This bypasses that staleness check only. Safe to run any time: it does
// not touch or reset the design-profile rescan (force-design-profile-
// rescan.js) — the two are independent systems (page_inventory drives WHERE
// an agent looks for issues to fix; the design profile drives WHAT it's
// allowed to generate there) that happen to share the same staleness-gate
// shape.
//
// Usage: node server/scripts/force-site-discovery.js
import 'dotenv/config';
import { runSiteDiscoveryIfDueForAllSites } from '../job.js';

const results = await runSiteDiscoveryIfDueForAllSites({ force: true });
const ran = results.filter(Boolean);
console.log(`Ran site discovery for ${ran.length}/${results.length} connected site(s).`);
for (const r of ran) {
  console.log(`  ${r.sitemapCount} sitemap URL(s), ${r.crawlCount} crawled URL(s), ${r.gscCount} GSC page(s), ${r.orphanedCount} orphaned.`);
}
process.exit(0);
