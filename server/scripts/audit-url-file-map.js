import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { resolveFile, resolveMarkers, resolveAdapter } from '../implementers/lib/url-file-map.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent } from '../github/client.js';
import { STAGE_BRANCH } from '../implementers/lib/github-ops.js';

// Read-only config-completeness audit for a site's url_file_map — surfaces
// exactly the class of gap that let the homepage-FAQ and /compare/-FAQ
// drafts get stuck ("No url_file_map entry matches...", "No markers
// configured...") BEFORE an agent ever recommends a page nothing can
// deploy to, instead of discovering it only at approve/push time.
//
//   node server/scripts/audit-url-file-map.js --site-id <id>
//
// --all is accepted but not yet wired to real multi-site iteration — see
// the note above main(). Structured now (auditSite() takes one siteId,
// called from a siteIds loop) so wiring --all later is additive, not a
// rewrite: swap the single-id array for listConnectedSites()'s ids.

const ACTION_TYPES = ['meta-title', 'faq', 'schema', 'internal-links'];
const DEFAULT_WINDOW_DAYS = 90;
const PAGE_LIMIT = 300;

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

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

async function auditSite(siteId) {
  const site = await getSiteById(siteId);
  if (!site) { console.log(`Site #${siteId}: not found — skipping.`); return; }
  if (!site.repo_owner || !site.repo_name) {
    console.log(`Site #${siteId} "${site.name}": no repo configured yet — skipping (nothing to audit against).`);
    return;
  }

  const { start, end } = defaultRange();
  const rawPages = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_LIMIT);
  // A domain-level GSC property (sc-domain:...) returns pages from every
  // subdomain it has data for, including unrelated products on the same
  // root domain (see agents/lib/site-domain.js) — filtered the same way
  // selectCandidatePages/ai-recommendation.js already do, so this audit's
  // "real candidate pages" pool matches what the actual recommendation
  // agents use, not raw unfiltered GSC data.
  const pages = filterOwnDomainPages(rawPages, knownDomain(site));
  const pageUrls = pages.map((p) => p.dim_value);
  if (rawPages.length !== pages.length) {
    console.log(`(filtered ${rawPages.length - pages.length} page(s) from other subdomains — knownDomain: ${knownDomain(site) || '(none configured)'})`);
  }

  console.log(`\n=== Site #${siteId} "${site.name}" (${site.repo_owner}/${site.repo_name}) — ${pageUrls.length} real candidate pages, ${ACTION_TYPES.length} action types ===`);

  const noFileMapping = []; // { page, actionType }
  const noMarkers = Object.fromEntries(ACTION_TYPES.map((t) => [t, []])); // actionType -> [page]
  const adapterRouted = []; // { page, actionType, adapterId }
  const fileExistsCache = new Map(); // filePath -> true | false | 'error'

  for (const page of pageUrls) {
    const filePath = resolveFile(site, page);

    for (const actionType of ACTION_TYPES) {
      const adapterConfig = resolveAdapter(site, page, actionType);
      if (adapterConfig) {
        adapterRouted.push({ page, actionType, adapterId: adapterConfig.id });
        continue; // the adapter owns its own file/field validation, not this script's concern
      }

      if (!filePath) {
        noFileMapping.push({ page, actionType });
        continue;
      }

      const markers = resolveMarkers(site, page, actionType);
      if (!markers) noMarkers[actionType].push(page);
    }

    // One real, read-only GitHub read per unique file path (cached across
    // pages/action types) — confirms a configured path isn't stale/typo'd,
    // without hammering the API once per (page, actionType) combination.
    if (filePath && !fileExistsCache.has(filePath)) {
      try {
        const file = await getFileContent(site, filePath, STAGE_BRANCH);
        fileExistsCache.set(filePath, !!file);
      } catch (err) {
        fileExistsCache.set(filePath, 'error');
        console.warn(`  (could not check ${filePath}: ${err.message})`);
      }
    }
  }

  const missingFiles = [...fileExistsCache.entries()].filter(([, exists]) => exists === false).map(([p]) => p);

  console.log(`\n-- NO FILE MAPPING (${noFileMapping.length}) --`);
  for (const { page, actionType } of noFileMapping) console.log(`  [${actionType}] ${page}`);

  for (const actionType of ACTION_TYPES) {
    console.log(`\n-- NO MARKERS CONFIGURED (${actionType}) (${noMarkers[actionType].length}) --`);
    for (const page of noMarkers[actionType]) console.log(`  ${page}`);
  }

  console.log(`\n-- FILE NOT FOUND IN REPO (${missingFiles.length}) --`);
  for (const filePath of missingFiles) console.log(`  ${filePath}`);

  console.log(`\n-- ADAPTER-ROUTED, not deep-checked here (${adapterRouted.length}) --`);
  const byAdapter = adapterRouted.reduce((acc, r) => { (acc[r.adapterId] ||= []).push(`[${r.actionType}] ${r.page}`); return acc; }, {});
  for (const [adapterId, entries] of Object.entries(byAdapter)) {
    console.log(`  ${adapterId}: ${entries.length} page/type combination(s)`);
  }

  const clean = noFileMapping.length === 0 && missingFiles.length === 0 && ACTION_TYPES.every((t) => noMarkers[t].length === 0);
  console.log(`\nSite #${siteId}: ${clean ? 'CLEAN — no gaps found.' : 'gaps found — see above.'}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.all) {
    console.error('--all is not implemented yet — pass --site-id <id> for now. (listConnectedSites() is already imported and ready for when this is wired up.)');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  if (!flags['site-id']) {
    console.error('Usage: node server/scripts/audit-url-file-map.js --site-id <id>  (or --all, not yet implemented)');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const siteIds = [Number(flags['site-id'])];
  for (const id of siteIds) await auditSite(id);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
