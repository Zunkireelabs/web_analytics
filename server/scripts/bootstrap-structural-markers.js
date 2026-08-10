import 'dotenv/config';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { resolveFile, resolveMarkers, resolveAdapter } from '../implementers/lib/url-file-map.js';
import { hasMarker, classifyMarkerGap } from '../implementers/lib/marker-merge.js';
import { detectInsertionPoint, detectHeadRegion } from '../implementers/lib/structural-detect.js';
import { getOrDetectStrategy } from '../implementers/lib/strategy-registry.js';
import { MARKER_MERGE_TYPES } from '../implementers/backend.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';

// New-client-onboarding / existing-client-migration tool for the universal
// insertion engine (requirements 10 and 12: a newly connected repo, or an
// existing one being re-scanned for newly added pages, should be able to
// receive real recommendations without starting from zero).
//
// This used to open a separate "bootstrap PR" per missing marker
// (marker-bootstrap.js, since removed) — that mechanism turned out to be
// fully subsumed once structural detection moved INSIDE the real
// marker-existence pipeline itself (insertion-engine.js's resolveInsertion,
// wired into backend.js's computeMarkerMerge): a body-content gap now either
// self-heals inline, in the very first real recommendation's own daily
// batch PR, or it's genuinely undetectable — and a genuinely undetectable
// page can't be helped by a separate PR either, since the same detector
// chain runs either way. There is no case left where "run this ahead of
// time and open a PR" succeeds somewhere "just let the first real
// recommendation handle it" wouldn't have anyway.
//
// So this script's real remaining job is narrower but still valuable:
//   1. WARM the Strategy Registry (strategy-registry.js) across every real,
//      resolvable page/action-type combo — so template-identity reuse is
//      available from day one, and a brand-new client's very first
//      recommendation for any given page is both instant (cache hit) and
//      pre-validated, rather than a cold detection running for the first
//      time inside a live batch.
//   2. REPORT which pages/templates have no detectable insertion point at
//      all yet — this platform's own "Repository Learning Rule": a
//      genuinely undetectable structure means the shared analyzer needs to
//      be extended (a new detector/template-identity rule), not that any
//      individual page needs a hand-placed marker. Read-only diagnostic,
//      same spirit as audit-url-file-map.js.
//
//   node server/scripts/bootstrap-structural-markers.js --site-id <id>

const PAGE_LIMIT = 300;
const DETECTORS = { detectBody: detectInsertionPoint, detectHead: detectHeadRegion };

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
  // only needs to warm/report on that file once, not once per page URL that
  // happens to resolve to it.
  const targets = new Map(); // `${filePath}::${markerName}` -> { filePath, markerField, markerName }
  const fileCache = new Map();

  for (const { dim_value: page } of pages) {
    const filePath = resolveFile(site, page);
    if (!filePath) continue;

    for (const actionType of MARKER_MERGE_TYPES) {
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

  let alreadyPresent = 0, selfHeals = 0, warmed = 0, headGaps = 0, frontMatterGaps = 0, undetectable = 0;

  for (const { filePath, markerField, markerName } of targets.values()) {
    const content = fileCache.get(filePath);
    if (!content || content === 'error') continue;
    if (hasMarker(content, markerName)) { alreadyPresent++; continue; }

    const gap = classifyMarkerGap(markerField, filePath, content, DETECTORS);
    if (gap === 'self-heals') {
      selfHeals++;
      // Warm the Strategy Registry now rather than waiting for the first
      // real recommendation to trigger it cold — also the step that makes
      // template-identity reuse available to every OTHER page sharing this
      // file's template from this point forward.
      const strategy = await getOrDetectStrategy(site, filePath, content);
      if (strategy.ok) {
        warmed++;
        console.log(`  [warmed]  ${filePath} (SEOAI:${markerName}) -> ${strategy.containerDescription} [${strategy.source}]`);
      }
      continue;
    }
    if (gap === 'fatal-no-head-region') {
      headGaps++;
      console.log(`  [gap]     ${filePath} (SEOAI:${markerName}): no <head> element could be found to auto-create a SEOAI:HEAD region — a sitewide layout concern, see the action-center-onboarding skill.`);
      continue;
    }
    if (gap === 'fatal-no-front-matter') {
      frontMatterGaps++;
      console.log(`  [gap]     ${filePath} (SEOAI:${markerName}): no front matter block found for a LINE-convention field.`);
      continue;
    }
    undetectable++;
    console.log(`  [platform-gap] ${filePath} (SEOAI:${markerName}): no structural strategy could be found for this file — this is a shared-analyzer gap (structural-detect.js), not a per-page fix. Record it per this repo's Repository Learning Rule.`);
  }

  console.log(`\n-- SUMMARY: ${alreadyPresent} already had a marker, ${selfHeals} self-heal at apply time (${warmed} warmed into the Strategy Registry now), ${headGaps} need a sitewide HEAD region, ${frontMatterGaps} need front matter, ${undetectable} need a shared-analyzer improvement --`);
  if (undetectable > 0 || headGaps > 0) console.log('These are platform/analyzer gaps, not manual per-page marker placement — see structural-detect.js\'s detector chain and template-identity.js.');
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
