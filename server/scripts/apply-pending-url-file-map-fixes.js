// One-off script applying the two confirmed-safe url_file_map fixes from
// the 2026-09-15 Action Center audit:
//
//   1. Chayce (site 8864): adds a "/get-started/index.html" page mapping
//      alongside the existing "/get-started/" one — the site's real URLs use
//      the explicit index.html + query-string form, which was never mapped.
//      Clears ~24 blocked expand-content/breadcrumbs recommendations.
//
//   2. Zunkiree (site 1): adds a "content-integrity-repair" adapter entry to
//      the two /locations/* patterns and the /compare/* pattern, mirroring
//      the existing faq/schema/meta-title adapters already configured there.
//      Clears the /locations/* and /compare/* content-integrity-repair
//      "no per-page file to map" blocks.
//
//   3. Zunkiree (site 1): adds a "faq" adapter entry to the /compare/*
//      pattern, matching the flat /locations/* faq adapter's shape
//      (itemsField: 'faqs', no schemaField — the FAQPage schema is rendered
//      inline in the template's own {% for faq in comp.faqs %} loop, same
//      as location.njk, not a separate JSON field). REQUIRES PR #99
//      (github.com/Zunkireelabs/zunkireelabs-web/pull/99, "Add FAQ
//      rendering block to comparison.njk") to be MERGED first — before that
//      merges, comp.faqs has nowhere to render, so a drafted FAQ would be
//      written but invisible on the live page. Safe to apply this script
//      before the PR merges (the adapter config alone does nothing without
//      a draft), but don't ship/approve a /compare/* FAQ draft until #99 is
//      live.
//
// Idempotent — safe to re-run; each write only adds a key if absent.
//
// Usage: node server/scripts/apply-pending-url-file-map-fixes.js
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fixChayce() {
  const { rows } = await pool.query('select url_file_map from sites where id=8864');
  const map = rows[0].url_file_map;
  if (map.pages['/get-started/index.html']) {
    console.log('[chayce] /get-started/index.html already mapped — skipping.');
    return;
  }
  map.pages['/get-started/index.html'] = map.pages['/get-started/'];
  await pool.query('update sites set url_file_map=$1 where id=8864', [JSON.stringify(map)]);
  console.log('[chayce] added /get-started/index.html -> src/get-started.njk');
}

async function fixZunkiree() {
  const { rows } = await pool.query('select url_file_map from sites where id=1');
  const map = rows[0].url_file_map;
  const patterns = map.patterns || [];

  const locNested = patterns.find((p) => p.match === '^/locations/([^/]+)/([^/]+)/?$');
  const locFlat = patterns.find((p) => p.match === '^/locations/([^/]+)/?$');
  const compare = patterns.find((p) => p.match === '^/compare/([^/]+)/?$');

  let changed = false;
  if (locNested && !locNested.adapters['content-integrity-repair']) {
    locNested.adapters['content-integrity-repair'] = {
      id: 'data-array-content', format: 'js-export-array', idField: 'id',
      dataFile: 'src/_data/locations.js', nestedField: 'services',
    };
    changed = true;
    console.log('[zunkiree] added content-integrity-repair adapter to /locations/*/* (nested)');
  }
  if (locFlat && !locFlat.adapters['content-integrity-repair']) {
    locFlat.adapters['content-integrity-repair'] = {
      id: 'data-array-content', format: 'js-export-array', idField: 'id',
      dataFile: 'src/_data/locations.js',
    };
    changed = true;
    console.log('[zunkiree] added content-integrity-repair adapter to /locations/*');
  }
  if (compare && !compare.adapters['content-integrity-repair']) {
    compare.adapters['content-integrity-repair'] = {
      id: 'data-array-content', format: 'js-export-array', idField: 'id',
      dataFile: 'src/_data/comparisons.js',
    };
    changed = true;
    console.log('[zunkiree] added content-integrity-repair adapter to /compare/*');
  }
  if (compare && !compare.adapters.faq) {
    compare.adapters.faq = {
      id: 'data-array-content', format: 'js-export-array', idField: 'id',
      dataFile: 'src/_data/comparisons.js', itemsField: 'faqs',
    };
    changed = true;
    console.log('[zunkiree] added faq adapter to /compare/* — only ships once PR #99 (comparison.njk FAQ rendering) is merged');
  }

  if (!changed) {
    console.log('[zunkiree] all three patterns already have content-integrity-repair configured — skipping.');
    return;
  }
  await pool.query('update sites set url_file_map=$1 where id=1', [JSON.stringify(map)]);
}

async function main() {
  await fixChayce();
  await fixZunkiree();
  await pool.end();
  console.log('Done. The next daily blocked-recommendation refresh (or the next deploy, via reconcileBlockedRecommendationsOnStartup) will re-evaluate the affected rows.');
}

main().catch((err) => { console.error(err); process.exit(1); });
