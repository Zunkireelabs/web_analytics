import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { resolveFile, resolveMarkers, resolveAdapter } from '../implementers/lib/url-file-map.js';
import { hasMarker } from '../implementers/lib/marker-merge.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { getLessons } from '../lessons.js';

// Read-only config-completeness audit for a site's url_file_map — surfaces
// exactly the class of gap that let the homepage-FAQ and /compare/-FAQ
// drafts get stuck ("No url_file_map entry matches...", "No markers
// configured...") BEFORE an agent ever recommends a page nothing can
// deploy to, instead of discovering it only at approve/push time.
//
// Config-completeness alone isn't enough, though — a real incident showed
// url_file_map can still declare a marker name that config-wise looks fine
// while the actual `SEOAI:<name>` comment has quietly vanished from the live
// file (e.g. after a client-side template redesign that never touched this
// app). ensureMarkers (marker-merge.js) auto-creates a missing BLOCK/marker
// at apply-time for most fields, so this isn't fatal by itself — but for
// LINE-convention fields (front-matter `title:`) and HEAD-scoped fields
// (canonical/openGraph, which are never auto-inserted at EOF), a vanished
// marker means every draft for that (page, actionType) is doomed to fail at
// push time. This audit now fetches each configured file's real live
// content and checks with hasMarker(), so that class of drift is caught
// here, proactively, instead of burning generation + review time on a draft
// that can never actually apply.
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
  const fileCache = new Map(); // filePath -> { content } | false | 'error'
  const markersToCheck = []; // { page, actionType, filePath, markerField, markerName }

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
      if (!markers) { noMarkers[actionType].push(page); continue; }

      for (const [markerField, markerName] of Object.entries(markers)) {
        markersToCheck.push({ page, actionType, filePath, markerField, markerName });
      }
    }

    // One real, read-only GitHub read per unique file path (cached across
    // pages/action types) — confirms a configured path isn't stale/typo'd,
    // and its real content is what the marker-presence check below runs
    // against, without hammering the API once per (page, actionType) combo.
    if (filePath && !fileCache.has(filePath)) {
      try {
        const file = await getFileContent(site, filePath, baseBranch(site));
        fileCache.set(filePath, file ? { content: file.content } : false);
      } catch (err) {
        fileCache.set(filePath, 'error');
        console.warn(`  (could not check ${filePath}: ${err.message})`);
      }
    }
  }

  const missingFiles = [...fileCache.entries()].filter(([, v]) => v === false).map(([p]) => p);

  // Real evidence, not config — only meaningful for a file that actually
  // exists and was readable; a missing/errored file is already reported
  // above and would just double-report as "marker missing" too.
  const markersMissing = markersToCheck.filter(({ filePath, markerName }) => {
    const cached = fileCache.get(filePath);
    return cached && cached !== 'error' && !hasMarker(cached.content, markerName);
  });

  console.log(`\n-- NO FILE MAPPING (${noFileMapping.length}) --`);
  for (const { page, actionType } of noFileMapping) console.log(`  [${actionType}] ${page}`);

  for (const actionType of ACTION_TYPES) {
    console.log(`\n-- NO MARKERS CONFIGURED (${actionType}) (${noMarkers[actionType].length}) --`);
    for (const page of noMarkers[actionType]) console.log(`  ${page}`);
  }

  console.log(`\n-- FILE NOT FOUND IN REPO (${missingFiles.length}) --`);
  for (const filePath of missingFiles) console.log(`  ${filePath}`);

  console.log(`\n-- MARKERS MISSING FROM LIVE FILE (configured, but SEOAI:<name> comment isn't actually in the file) (${markersMissing.length}) --`);
  for (const { page, actionType, filePath, markerField, markerName } of markersMissing) {
    console.log(`  [${actionType}:${markerField}] ${page} -> ${filePath} (expected SEOAI:${markerName})`);
  }

  console.log(`\n-- ADAPTER-ROUTED, not deep-checked here (${adapterRouted.length}) --`);
  const byAdapter = adapterRouted.reduce((acc, r) => { (acc[r.adapterId] ||= []).push(`[${r.actionType}] ${r.page}`); return acc; }, {});
  for (const [adapterId, entries] of Object.entries(byAdapter)) {
    console.log(`  ${adapterId}: ${entries.length} page/type combination(s)`);
  }

  const clean = noFileMapping.length === 0 && missingFiles.length === 0 && markersMissing.length === 0
    && ACTION_TYPES.every((t) => noMarkers[t].length === 0);
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

  // fix_lessons (migration 086) recorded with no generator_id are
  // structural/architectural gotchas learned from real past fixes (e.g.
  // "a page pattern may already get its schema/content computed by the
  // site's own template at build time — check before wiring a generator
  // adapter for it") rather than a single generator's prompt mistake.
  // Surfacing them here, at onboarding-audit time, is what lets a new
  // client's config get checked against issues already hit once before —
  // instead of re-discovering the same class of gap from scratch.
  for (const id of siteIds) {
    const lessons = await getLessons(null, id);
    if (lessons.length) {
      console.log(`\nKnown issues to check for site #${id} (from past fixes):`);
      for (const l of lessons) console.log(`  - ${l.title}: ${l.lesson}`);
    }
  }

  for (const id of siteIds) await auditSite(id);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
