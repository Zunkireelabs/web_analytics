import 'dotenv/config';
import { pool } from '../db.js';
import { listOpenRecommendations, closeRecommendation } from '../store/recommendations.js';
import { getSiteById } from '../store/read.js';
import { resolveFile, resolveAdapter } from '../implementers/lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';

// One-off backlog cleanup for a real gap fixed in agents/lib/recommendations.js
// (2026-08-10): that fix stops NEW recommendations from being created for a
// page whose url_file_map-resolved file doesn't actually exist (a soft-404
// treated as real by an agent, or a generic pattern's wrong guess — see that
// file's own comment for the full incident). It only guards recommendation
// CREATION, though — it does nothing for recommendations already sitting
// open in the table from before the fix shipped. This script applies the
// exact same live-existence check retroactively, once, so that backlog
// doesn't have to be closed by hand, one "Discard Draft" click at a time.
//
//   node server/scripts/cleanup-unresolvable-recommendations.js --site-id <id>          (dry run, default)
//   node server/scripts/cleanup-unresolvable-recommendations.js --site-id <id> --apply   (actually supersede)

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) throw new Error('Usage: cleanup-unresolvable-recommendations.js --site-id <id> [--apply]');
  const apply = !!flags.apply;

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`Site #${siteId} not found`);

  const recs = await listOpenRecommendations(siteId);
  console.log(`Site #${siteId} (${site.name}): ${recs.length} open recommendation(s) to check.\n`);
  console.log(`Mode: ${apply ? 'APPLY (will supersede)' : 'DRY RUN (pass --apply to actually close these)'}\n`);

  const fileCache = new Map(); // path@ref -> file | null
  const cachedFetchFile = async (path, ref) => {
    const key = `${path}@${ref}`;
    if (fileCache.has(key)) return fileCache.get(key);
    const file = await getFileContent(site, path, ref).catch(() => null);
    fileCache.set(key, file);
    return file;
  };

  let staleCount = 0;
  for (const rec of recs) {
    // broken-link-fix and adapter-routed pages are a different concern
    // (backend.js/data-array-content.js validate those themselves) — this
    // script only targets the "url_file_map resolved a path, but that file
    // doesn't actually exist" class of gap, same scope as the recommendations.js
    // fix it's retroactively applying.
    if (rec.recommendation_type === 'broken-link-fix') continue;
    if (!rec.page) continue;
    // recommendationPageKey (recommendation-coordinator.js) stores
    // expand-content rows as "<url>::<focus>" (its dedup key needs the focus
    // too, since one page can have several open expand-content recs at
    // once) — the real URL is only the part before "::".
    const url = rec.recommendation_type === 'expand-content' ? rec.page.split('::')[0] : rec.page;
    if (!url) continue;
    if (resolveAdapter(site, url, rec.recommendation_type)) continue;

    const filePath = resolveFile(site, url);
    if (!filePath) continue; // no file mapping at all — a pre-existing, different gap class, not this script's concern

    const file = await cachedFetchFile(filePath, baseBranch(site));
    if (file) continue; // file genuinely exists — this recommendation is fine

    staleCount++;
    console.log(`  [#${rec.id}] ${rec.recommendation_type} — ${url} -> ${filePath} (does not exist)`);
    if (apply) await closeRecommendation(rec.id);
  }

  console.log(`\n${staleCount} unresolvable recommendation(s) found${apply ? ', superseded.' : '.'}`);
  if (!apply && staleCount) console.log('Re-run with --apply to actually close these.');
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err); pool.end(); process.exit(1); });
