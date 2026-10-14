#!/usr/bin/env node
// Closes open `recommendations` rows whose target page is a legacy
// foreign-platform spam URL (index-bloat.js's isForeignPlatformSpamUrl —
// the exact chayceproperties.com ?h=/*.aspx pattern), left behind after
// candidate-pages.js and job.js's site-discovery were fixed to stop ever
// scanning/ingesting those URLs again.
//
// Why this can't wait for the existing self-heal path: closeStaleRecommendations
// (store/recommendations.js) only closes a row once the page was actually
// re-checked THIS run and the issue wasn't re-detected — a page candidate-pages.js
// now excludes from every future batch is simply never re-checked, so these
// rows would sit open forever without this one-time sweep. This is a single
// pass, not a recurring job: once run, no NEW spam-page recommendation can
// ever be created (candidate-pages.js/job.js already prevent that upstream).
//
// Uses dismissRecommendation (status='dismissed') — not closeRecommendation
// ('superseded', meaning "re-checked, issue gone") and not markRecommendationsUnfixable
// ('unfixable', meaning "tried and proven impossible") — because neither of
// those claims is true here. The recommendation was never real to begin
// with: its target was never a page this site actually serves. 'dismissed'
// is documented for exactly this ("a human deciding a recommendation is not
// real/not worth acting on"), and — same as every other terminal status —
// frees the dedup key, so a real, unrelated future finding on the same
// (page, type) can still open a fresh row.
//
// A recommendation's `page` column is sometimes a compound key
// (`${url}::${subtype}`, e.g. expand-content's own findings) — strip
// anything from the first `::` before testing, same convention
// closeStaleRecommendations itself uses for recommendationPageKey().
//
// Dry run by default; --apply to commit.
import 'dotenv/config';
import { pool } from '../db.js';
import { listOpenRecommendations, dismissRecommendation } from '../store/recommendations.js';
import { isForeignPlatformSpamUrl } from '../agents/lib/index-bloat.js';

function parseArgs(argv) {
  const args = { siteId: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') args.siteId = Number(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId) {
    console.error('Usage: node server/scripts/dismiss-spam-page-recommendations.js --site-id <id> [--apply]');
    process.exit(1);
  }

  const open = await listOpenRecommendations(args.siteId);
  const spam = open.filter((r) => r.page && isForeignPlatformSpamUrl(r.page.split('::')[0]));

  if (!spam.length) {
    console.log(`site ${args.siteId}: no open recommendations target a spam URL. Nothing to do.`);
    return;
  }

  console.log(`site ${args.siteId}: ${spam.length} open recommendation(s) target a legacy spam URL:`);
  for (const r of spam) console.log(`  #${r.id}  ${r.recommendation_type}  ${r.page}`);

  if (!args.apply) {
    console.log('\nDry run. Re-run with --apply to dismiss them.');
    return;
  }

  for (const r of spam) await dismissRecommendation(r.id);
  console.log(`\nDismissed ${spam.length} recommendation(s).`);
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
