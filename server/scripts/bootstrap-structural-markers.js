import 'dotenv/config';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { resolveFile, resolveMarkers, resolveAdapter } from '../implementers/lib/url-file-map.js';
import { hasMarker, classifyMarkerGap } from '../implementers/lib/marker-merge.js';
import { detectAndOpenBootstrapPr } from '../implementers/lib/marker-bootstrap.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';

// Requirement-8 automation: proactively opens bootstrap PRs (see
// marker-bootstrap.js) for every page whose body-content marker is missing
// AND structurally detectable, instead of waiting for the first real
// recommendation on that page to trigger detectAndOpenBootstrapPr lazily
// (backend.js's computeMarkerMerge already does that on-demand; this script
// is the batch/onboarding-time version of the same call). Run this once
// right after `npm run connect-repo` for a new client, or any time on an
// existing one to catch newly-added pages — it's read-mostly and idempotent
// (marker-bootstrap.js reuses an already-open PR for the same file+marker
// rather than opening duplicates).
//
// Same ACTION_TYPES/gap-classification logic as audit-url-file-map.js's
// auditSite(), narrowed to exactly the gap class this script can act on:
// 'fatal-no-safe-anchor' (a body-scoped field — qaContent/expandedContent —
// missing on a component-based template). 'fatal-no-head-region' and
// 'fatal-no-front-matter' are sitewide/layout concerns a human still places
// once (see the action-center-onboarding skill, §2) — genuinely not safe to
// guess at structurally, so this script doesn't touch them.
//
//   node server/scripts/bootstrap-structural-markers.js --site-id <id>

const ACTION_TYPES = ['expand-content', 'qa-content'];
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
  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { start, end };
}

export async function bootstrapSite(siteId) {
  const site = await getSiteById(siteId);
  if (!site) { console.log(`Site #${siteId}: not found — skipping.`); return; }
  if (!site.repo_owner || !site.repo_name) {
    console.log(`Site #${siteId} "${site.name}": no repo configured yet — run \`npm run connect-repo\` first.`);
    return;
  }

  const { start, end } = defaultRange();
  const rawPages = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_LIMIT);
  const pages = filterOwnDomainPages(rawPages, knownDomain(site));
  console.log(`\n=== Site #${siteId} "${site.name}" (${site.repo_owner}/${site.repo_name}) — ${pages.length} real candidate pages ===`);

  // Unique (filePath, markerName) pairs only — several pages can share one
  // component file (e.g. a single dynamic [slug].tsx template), and this
  // only needs to bootstrap that file once, not once per page URL that
  // happens to resolve to it.
  const targets = new Map(); // `${filePath}::${markerName}` -> { filePath, markerName }
  const fileCache = new Map();

  for (const { dim_value: page } of pages) {
    const filePath = resolveFile(site, page);
    if (!filePath) continue;

    for (const actionType of ACTION_TYPES) {
      if (resolveAdapter(site, page, actionType)) continue; // adapter-routed pages own their own data path, not a marker gap
      const markers = resolveMarkers(site, page, actionType);
      if (!markers) continue;
      for (const [markerField, markerName] of Object.entries(markers)) {
        targets.set(`${filePath}::${markerName}`, { filePath, markerField, markerName });
      }
    }

    if (!fileCache.has(filePath)) {
      try {
        const file = await getFileContent(site, filePath, baseBranch(site));
        fileCache.set(filePath, file ? file.content : false);
      } catch (err) {
        fileCache.set(filePath, 'error');
        console.warn(`  (could not read ${filePath}: ${err.message})`);
      }
    }
  }

  let opened = 0, reused = 0, noContainer = 0, alreadyPresent = 0, errors = 0;

  for (const { filePath, markerField, markerName } of targets.values()) {
    const content = fileCache.get(filePath);
    if (!content || content === 'error') continue;
    if (hasMarker(content, markerName)) { alreadyPresent++; continue; }
    if (classifyMarkerGap(markerField, filePath, content) !== 'fatal-no-safe-anchor') continue; // self-heals at apply time already, nothing to bootstrap

    const result = await detectAndOpenBootstrapPr(site, filePath, content, markerName);
    if (result.ok && result.opened) { opened++; console.log(`  [opened]  ${filePath} (SEOAI:${markerName}) -> ${result.prUrl}`); }
    else if (result.ok && !result.opened) { reused++; console.log(`  [pending] ${filePath} (SEOAI:${markerName}) already has an open bootstrap PR -> ${result.prUrl}`); }
    else if (result.reason === 'no-confident-container') { noContainer++; console.log(`  [manual]  ${filePath} (SEOAI:${markerName}): ${result.error}`); }
    else { errors++; console.log(`  [error]   ${filePath} (SEOAI:${markerName}): ${result.error}`); }
  }

  console.log(`\n-- SUMMARY: ${opened} bootstrap PR(s) opened, ${reused} already pending review, ${alreadyPresent} already had a marker, ${noContainer} need manual placement (no confident container found), ${errors} error(s) --`);
  if (opened > 0 || reused > 0) console.log('Merge the PR(s) above once — after that, recommendations for those pages apply with no further manual step.');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = flags['site-id'];
  if (!siteId) {
    console.error('Usage: node server/scripts/bootstrap-structural-markers.js --site-id <id>');
    process.exit(1);
  }
  await bootstrapSite(Number(siteId));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
