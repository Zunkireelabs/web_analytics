// READ-ONLY. Does every blog post a site lists across ALL its pagination pages reach SuperRank's inventory, get analysed, and have a file a
// fix could be applied to? Writes nothing anywhere; the only network use is plain GETs of the site's own public listing pages.
//
//   node server/scripts/verify-blog-coverage.js --site-id 1 [--listing /blog/ --listing /nl/blog/] [--max-pages 150]
//
// Listings are auto-detected from the site's own sitemap when none are given: a top-level path that has many single-segment children
// (/blog/<slug>/). Pagination is followed through /page/N/ links, and a child that is itself a listing (/blog/articles/, which has its own
// /page/N/) is followed too, never counted as a post.
import 'dotenv/config';
import { pool } from '../db.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { discoverFromSitemaps } from '../agents/lib/site-discovery.js';
import { detectListingRoots, classifyListingLinks, detectChildListings, crawlListing, pathOf } from '../agents/lib/blog-listing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { detectListingRoots, classifyListingLinks, detectChildListings };

async function main() {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const siteId = Number(val('--site-id'));
  if (!siteId) throw new Error('Usage: node server/scripts/verify-blog-coverage.js --site-id <id> [--listing /blog/] [--max-pages 150]');
  const listings = args.flatMap((a, i) => (a === '--listing' ? [args[i + 1]] : []));
  const maxPages = Number(val('--max-pages')) || 150;
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [siteId]);
  if (!site) throw new Error(`No site ${siteId}.`);
  const origin = `https://${String(site.website_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;

  const sitemapPaths = (await discoverFromSitemaps(site).catch(() => [])).map((u) => pathOf(u, origin)).filter(Boolean);
  let roots = listings;
  if (!roots.length) roots = detectListingRoots(sitemapPaths);
  if (!roots.length) { console.log('No blog-like listing found in the sitemap. Pass --listing /path/ to check one.'); return; }
  console.log(`Site ${siteId} (${origin}) listings: ${roots.join(', ')}`);

  const fetchHrefs = async (path) => {
    try {
      const r = await fetch(origin + path, { headers: { 'user-agent': 'readonly-verification/1.0' }, signal: AbortSignal.timeout(20000) });
      await sleep(250);
      return r.status === 200 ? [...(await r.text()).matchAll(/href="([^"#?]+)"/g)].map((m) => m[1]) : null;
    } catch { return null; }
  };
  const { posts, pages } = await crawlListing(roots, fetchHrefs, { childListings: detectChildListings(sitemapPaths, roots), maxPages });
  const listingsFetched = pages.length;
  const q = async (sql, p = [siteId]) => (await pool.query(sql, p)).rows;
  const norm = (u) => pathOf(u, origin);
  const inv = new Set((await q('SELECT page FROM page_inventory WHERE site_id=$1')).map((r) => norm(r.page)));
  const tech = new Set((await q('SELECT DISTINCT page FROM technical_seo_checks WHERE site_id=$1')).map((r) => norm(r.page)));
  const rot = new Set((await q('SELECT DISTINCT page FROM agent_page_rotation WHERE site_id=$1')).map((r) => norm(r.page)));
  const recs = new Set((await q('SELECT DISTINCT page FROM recommendations WHERE site_id=$1')).map((r) => norm(r.page)));
  const list = [...posts.keys()];
  const missing = list.filter((p) => !inv.has(p));
  const unmapped = list.filter((p) => !resolveFile(site, origin + p));
  const unexamined = list.filter((p) => inv.has(p) && !tech.has(p) && !rot.has(p));
  const n = (f) => list.filter(f).length;
  console.log(`\n${listingsFetched} listing/pagination page(s) fetched, ${list.length} distinct post(s) listed.`);
  console.log(`  in the page inventory:            ${n((p) => inv.has(p))} / ${list.length}   (missing: ${missing.length})`);
  console.log(`  technical-seo checked:            ${n((p) => tech.has(p))}`);
  console.log(`  examined by some agent:           ${n((p) => rot.has(p))}`);
  console.log(`  has a recommendation (any state): ${n((p) => recs.has(p))}`);
  console.log(`  URL resolves to a source file:    ${n((p) => !unmapped.includes(p))} / ${list.length}   (no mapping: ${unmapped.length})`);
  const show = (title, arr) => { if (arr.length) console.log(`\n${title} (${arr.length}):\n  ${arr.slice(0, 15).join('\n  ')}${arr.length > 15 ? `\n  … and ${arr.length - 15} more` : ''}`); };
  show('NOT in the inventory (never discovered)', missing);
  show('In the inventory but never checked or examined', unexamined);
  show('No source-file mapping, so a fix could not be applied', unmapped);
  if (!missing.length && !unmapped.length && !unexamined.length) console.log('\nEvery listed post is discovered, examined and fixable.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
