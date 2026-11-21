// The shared acceptance test for blog pagination, runnable on ANY stack's built output (Astro dist, Eleventy _site, Next out, Hugo public).
// Read-only: it reads two build folders and prints what is wrong, nothing else.
//
//   node server/scripts/check-pagination-build.js --built <dir> --origin https://example.com [--first /blog] [--baseline <dir>] [--sitemap <file>]
//
//   --built      the build AFTER the change
//   --baseline   a build of the same site BEFORE the change: proves nothing outside the listing and the sitemap changed
//   --first      the first listing page (default /blog); posts are the single-segment pages under it (/blog/<slug>)
//   --sitemap    a sitemap xml file; defaults to <built>/sitemap.xml or the first sitemap-*.xml found
// Exit code 1 when the build has a problem (warnings alone do not fail it).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBuiltSite, checkPagination, normRoute } from '../lib/pagination-acceptance.js';

const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const builtDir = val('--built'), origin = val('--origin');
if (!builtDir || !origin) { console.error('Usage: node server/scripts/check-pagination-build.js --built <dir> --origin <https://site> [--first /blog] [--baseline <dir>] [--sitemap <file>]'); process.exit(2); }
const first = normRoute(val('--first') || '/blog');
const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const built = loadBuiltSite(builtDir);
const baseline = val('--baseline') ? loadBuiltSite(val('--baseline')).pages : null;
let sitemapFile = val('--sitemap');
if (!sitemapFile) {
  const direct = join(builtDir, 'sitemap.xml');
  sitemapFile = existsSync(direct) ? direct : (readdirSync(builtDir).filter((f) => /^sitemap.*\.xml$/.test(f) && f !== 'sitemap-index.xml').map((f) => join(builtDir, f))[0] || null);
}
const result = checkPagination({
  built: built.pages, origin, firstPage: first, baseline,
  postPattern: new RegExp(`^${escaped}/[^/]+$`),
  sitemapXml: sitemapFile && existsSync(sitemapFile) ? readFileSync(sitemapFile, 'utf8') : null,
});
console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.pages.length} listing page(s), ${result.posts} post(s), sitemap ${sitemapFile ? 'checked' : 'not found (skipped)'}, baseline ${baseline ? 'compared' : 'not given (skipped)'}`);
for (const p of result.problems) console.log(`  PROBLEM: ${p}`);
for (const w of result.warnings) console.log(`  warning: ${w}`);
process.exit(result.ok ? 0 : 1);
