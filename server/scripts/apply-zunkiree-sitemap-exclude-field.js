// One-off script for Zunkiree (site 1), 2026-09-17.
//
// Verified against the live repo: src/sitemap.njk's loop checks exactly
// `page.data.excludeFromSitemap` (`{%- if page.url and not
// page.data.excludeFromSitemap %}`) — Eleventy reads a page's own YAML
// front matter as `page.data`, so setting `excludeFromSitemap: true` in a
// page's own front matter is the real, already-wired mechanism this site's
// sitemap template uses to skip a page. Unlocks the new
// sitemap-frontmatter-exclude generator for sitemap-conflict.js's 4
// currently-blocked sitemap-index-conflict findings on this site.
//
// Idempotent — safe to re-run; only writes if the field is absent.
//
// Usage: node server/scripts/apply-zunkiree-sitemap-exclude-field.js
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SITE_ID = 1;
const FIELD = 'excludeFromSitemap';

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=$1', [SITE_ID]);
  const map = rows[0].url_file_map;

  if (map.siteRoot?.sitemapExcludeField) {
    console.log(`[zunkiree] siteRoot.sitemapExcludeField already set to "${map.siteRoot.sitemapExcludeField}" — skipping.`);
    await pool.end();
    return;
  }

  map.siteRoot = { ...map.siteRoot, sitemapExcludeField: FIELD };
  await pool.query('update sites set url_file_map=$1 where id=$2', [JSON.stringify(map), SITE_ID]);
  await pool.end();
  console.log(`[zunkiree] set siteRoot.sitemapExcludeField = "${FIELD}"`);
  console.log('Done. The next daily sitemap-conflict run will re-evaluate the 4 currently-blocked findings against it.');
}

main().catch((err) => { console.error(err); process.exit(1); });
