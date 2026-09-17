import 'dotenv/config';
import { pool } from '../db.js';
import { isForeignPlatformSpamUrl } from '../agents/lib/index-bloat.js';
import { deletePageInventoryRows } from '../store/page-inventory.js';

// One-off cleanup for page_inventory rows that predate the spam-URL filters
// added to job.js's runSiteDiscoveryIfDue and candidate-pages.js's
// selectCandidatePages (see index-bloat.js's header comment for the
// chayceproperties.com incident this was built from). Those filters keep
// FUTURE rows out and already keep existing junk rows out of every agent's
// batch, so this script is pure hygiene — it stops these URLs from
// inflating page_inventory counts/listings (e.g. the get_page_inventory MCP
// tool) — not a correctness fix on its own.
//
// Only ever targets discovered_via = 'gsc' rows: a sitemap or crawl hit
// means this site itself actually serves/links the URL, which
// isForeignPlatformSpamUrl's own false-positive risk (a real page that
// happens to end in .php, say) makes too risky to delete sight-unseen.
// Dry run by default; --apply to commit.

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT site_id, page FROM page_inventory WHERE discovered_via = 'gsc'`
  );
  const bySite = new Map();
  for (const row of rows) {
    if (!isForeignPlatformSpamUrl(row.page)) continue;
    if (!bySite.has(row.site_id)) bySite.set(row.site_id, []);
    bySite.get(row.site_id).push(row.page);
  }

  if (!bySite.size) {
    console.log('No spam page_inventory rows found. Nothing to do.');
    return;
  }

  let total = 0;
  for (const [siteId, pages] of bySite) {
    total += pages.length;
    console.log(`site ${siteId}: ${pages.length} spam row(s)`);
    for (const page of pages.slice(0, 5)) console.log(`    ${page}`);
    if (pages.length > 5) console.log(`    (+${pages.length - 5} more)`);
  }
  console.log(`\n${total} spam row(s) across ${bySite.size} site(s).`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to delete.');
    return;
  }

  for (const [siteId, pages] of bySite) {
    const deleted = await deletePageInventoryRows(siteId, pages);
    console.log(`site ${siteId}: deleted ${deleted} row(s).`);
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
