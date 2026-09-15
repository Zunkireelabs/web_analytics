// Follow-up to apply-pending-url-file-map-fixes.js, now that
// zunkireelabs-web PR #99 ("Add FAQ rendering block to comparison.njk") has
// merged (confirmed 2026-09-15). That PR only changes the site's repo; the
// Action Center's own gate (recommendation-gates.js) still has no way to
// know that changed until this adapter config names WHICH file to check,
// so it stays a genuine, auto-retried "waiting on a template capability"
// blocked_reason forever otherwise — never able to auto-confirm the
// dependency actually shipped.
//
// Adds `templateFile` to Zunkiree's (site 1) /compare/* pattern's `faq`
// adapter config, pointing at the real shared layout PR #99 changed. Once
// this is in place, recommendation-gates.js's new check reads that file on
// every refresh and will clear the block itself the moment
// templateRendersItemsField confirms the loop exists — which it already
// does, now that PR #99 is merged.
//
// Idempotent — safe to re-run.
//
// Usage: node server/scripts/apply-compare-faq-template-file.js
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=1');
  const map = rows[0].url_file_map;
  const compare = (map.patterns || []).find((p) => p.match === '^/compare/([^/]+)/?$');
  if (!compare?.adapters?.faq) {
    console.log('[zunkiree] no /compare/* faq adapter found — nothing to do (run apply-pending-url-file-map-fixes.js first).');
    await pool.end();
    return;
  }
  if (compare.adapters.faq.templateFile) {
    console.log('[zunkiree] /compare/* faq adapter already has a templateFile — skipping.');
    await pool.end();
    return;
  }
  compare.adapters.faq.templateFile = 'src/_includes/layouts/comparison.njk';
  await pool.query('update sites set url_file_map=$1 where id=1', [JSON.stringify(map)]);
  console.log('[zunkiree] added templateFile "src/_includes/layouts/comparison.njk" to /compare/* faq adapter.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
