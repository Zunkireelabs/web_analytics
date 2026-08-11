import 'dotenv/config';
import { pool, recordActionCenterConfigCheck } from '../db.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { resolveFile, resolveMarkers, resolveAdapter, resolveSiteRootFile } from '../implementers/lib/url-file-map.js';
import { hasMarker, classifyMarkerGap } from '../implementers/lib/marker-merge.js';
import { hasHashMarker } from '../implementers/lib/hash-marker-merge.js';
import { detectInsertionPoint, detectHeadRegion } from '../implementers/lib/structural-detect.js';
import { resolveCapability, extensionOf } from '../implementers/lib/rendering-gate.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { findRelevantMemory } from '../agent-memory.js';

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
// app). This audit fetches each configured file's real live content and
// checks with hasMarker(), so that class of drift is caught here,
// proactively, instead of burning generation + review time on a draft that
// can never actually apply.
//
// A missing marker isn't automatically fatal, though — marker-merge.js's
// ensureMarkers() auto-creates most marker types at apply time (see its
// module comment). classifyMarkerGap (same module, imported above) is the
// single source of truth both this script and ensureMarkers use for "will
// this heal itself, or does it need a real human-placed anchor first" — so
// a missing BLOCK marker (schema/faq/links) is reported as self-healing
// noise, not counted as a real gap, and the count/summary below reflects
// only what genuinely needs a person: no file mapping, no markers
// configured at all, a missing file, or a marker gap classifyMarkerGap
// calls fatal (no front matter / no HEAD region / no safe body anchor).
// classifyMarkerGap now runs the same real structural detectors
// (structural-detect.js) the insertion engine itself uses (passed in as
// DETECTORS below) rather than a static field allowlist, so this script's
// "self-heals" count can never silently drift from what actually self-heals
// at apply time.
const DETECTORS = { detectBody: detectInsertionPoint, detectHead: detectHeadRegion };
//
// The nginx security-headers marker gets its own dedicated check (below,
// separate from ACTION_TYPES) since it's a site-root marker, not a
// per-page one, and — unlike every other marker type — can never be
// auto-created at apply time (see generators/security-headers.js): there's
// no framework-agnostic way to guess where inside an arbitrary nginx
// `server {}` block it belongs, so it's the one marker this audit must
// name explicitly rather than fold into a generic per-page count.
//
//   node server/scripts/audit-url-file-map.js --site-id <id>
//
// --all is accepted but not yet wired to real multi-site iteration — see
// the note above main(). Structured now (auditSite() takes one siteId,
// called from a siteIds loop) so wiring --all later is additive, not a
// rewrite: swap the single-id array for listConnectedSites()'s ids.

// Every PER-PAGE action type marker-merge.js's buildMergeValues() knows how
// to splice (its own `actionType === '...'` branches) — kept in sync with
// that list by hand since there's no registry to read it from generically.
// Used to be just 4 of these, which is exactly how a real "no markers
// configured" gap on analytics-install went undetected by this audit even
// after every other fix in this file: the audit simply never asked about
// it. llms-txt/robots.txt/sitemap (site-root, not per-page) and
// blog-outline/landing-page/translation (net-new content, no existing
// marker to check) are deliberately excluded — they're not marker-based.
const ACTION_TYPES = ['meta-title', 'faq', 'schema', 'internal-links', 'canonical', 'open-graph', 'expand-content', 'qa-content'];

// analytics-install is marker-based too, but SITEWIDE (installs GA4/Meta
// Pixel once, in the site's shared layout template) rather than per-page —
// backend.js's computeMarkerMerge routes it through
// url_file_map.siteRoot.layoutTemplate + defaults.placements, not
// resolveFile(page), so it needs its own dedicated check (below, alongside
// the nginx marker) instead of being folded into the per-page ACTION_TYPES
// loop, where it would incorrectly report "no file mapping" once per page.
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

// Exported so connect-repo.js can run this same check automatically right
// after url_file_map is set, instead of relying on the operator to remember
// a separate `npm run audit-url-file-map` step (the exact class of gap this
// whole script exists to catch — see the module comment above).
export async function auditSite(siteId) {
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
  // above and would just double-report as "marker missing" too. Split via
  // classifyMarkerGap (marker-merge.js) into what ensureMarkers will fix
  // automatically at apply time vs. what genuinely needs a human anchor —
  // the same classification the implementer itself uses, not a re-guess.
  const markersMissingRaw = markersToCheck.filter(({ filePath, markerName }) => {
    const cached = fileCache.get(filePath);
    return cached && cached !== 'error' && !hasMarker(cached.content, markerName);
  });
  const markersMissing = markersMissingRaw.map((m) => ({
    ...m, gap: classifyMarkerGap(m.markerField, m.filePath, fileCache.get(m.filePath).content, DETECTORS),
  }));
  const markersSelfHealing = markersMissing.filter((m) => m.gap === 'self-heals');
  const markersFatal = markersMissing.filter((m) => m.gap !== 'self-heals');

  console.log(`\n-- NO FILE MAPPING (${noFileMapping.length}) --`);
  for (const { page, actionType } of noFileMapping) console.log(`  [${actionType}] ${page}`);

  for (const actionType of ACTION_TYPES) {
    console.log(`\n-- NO MARKERS CONFIGURED (${actionType}) (${noMarkers[actionType].length}) --`);
    for (const page of noMarkers[actionType]) console.log(`  ${page}`);
  }

  console.log(`\n-- FILE NOT FOUND IN REPO (${missingFiles.length}) --`);
  for (const filePath of missingFiles) console.log(`  ${filePath}`);

  console.log(`\n-- MARKERS MISSING BUT SELF-HEALING (ensureMarkers creates these automatically at apply time — no action needed) (${markersSelfHealing.length}) --`);
  for (const { page, actionType, filePath, markerField, markerName } of markersSelfHealing) {
    console.log(`  [${actionType}:${markerField}] ${page} -> ${filePath} (will auto-create SEOAI:${markerName})`);
  }

  console.log(`\n-- MARKERS MISSING, FATAL (need a one-time human-placed anchor before any draft for this field can apply) (${markersFatal.length}) --`);
  for (const { page, actionType, filePath, markerField, markerName, gap } of markersFatal) {
    console.log(`  [${actionType}:${markerField}] ${page} -> ${filePath} (expected SEOAI:${markerName}, reason: ${gap})`);
  }

  console.log(`\n-- ADAPTER-ROUTED, not deep-checked here (${adapterRouted.length}) --`);
  const byAdapter = adapterRouted.reduce((acc, r) => { (acc[r.adapterId] ||= []).push(`[${r.actionType}] ${r.page}`); return acc; }, {});
  for (const [adapterId, entries] of Object.entries(byAdapter)) {
    console.log(`  ${adapterId}: ${entries.length} page/type combination(s)`);
  }

  // Rendering Validation Gate completeness (lib/rendering-gate.js) — every
  // newContentTargets entry (landing-page, blog-outline, direct-answer,
  // translation, legal/compliance pages, and any future net-new-content
  // generator) writes a fresh Markdown body via newpage-render.js, which
  // the real gate blocks at apply time unless url_file_map.renderCapabilities
  // proves that target's extension actually gets Markdown-processed. Checked
  // here too, at onboarding-audit time, using the exact same resolution
  // (resolveCapability) the real gate uses — so this class of gap is caught
  // BEFORE a staff member approves a draft that can never actually apply,
  // the same principle every other section of this audit already follows.
  const newContentTargets = site.url_file_map?.newContentTargets || {};
  const renderCapabilityGaps = []; // { actionType, extension, reason }
  for (const [actionType, target] of Object.entries(newContentTargets)) {
    if (!target?.extension) continue;
    const syntheticPath = `${target.dir || ''}/example${target.extension}`;
    const { caps, capability } = resolveCapability(site, { path: syntheticPath, actionType });
    if (!caps) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'no-render-capabilities-configured' });
    } else if (!capability) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'extension-not-recorded' });
    } else if (!capability.markdown) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'recorded-not-markdown-safe' });
    }
  }
  console.log(`\n-- RENDER CAPABILITY GAPS (${renderCapabilityGaps.length}) -- (net-new pages this site can generate but the gate will block at apply time)`);
  for (const { actionType, extension, reason } of renderCapabilityGaps) {
    console.log(`  [${actionType}] extension "${extension}" — ${reason}`);
  }
  if (Object.keys(newContentTargets).length && !renderCapabilityGaps.length) {
    console.log('  OK — every configured newContentTargets extension has a recorded, markdown-safe renderCapabilities entry.');
  }

  // Dedicated nginx security-headers marker check — a site-root marker, not
  // per-page, and the one marker type that can NEVER auto-create itself
  // (see the module comment above), so it gets checked and named explicitly
  // instead of folding into the generic per-page counts above.
  const nginxPath = resolveSiteRootFile(site, 'nginxConfig');
  let nginxMarkerOk = null; // null = not configured, so nothing to check
  if (nginxPath) {
    try {
      const file = await getFileContent(site, nginxPath, baseBranch(site));
      // nginx uses `#`-comment markers, not marker-merge.js's `<!-- -->`
      // convention (see backend.js's applySecurityHeaders/hash-marker-merge.js)
      // — hasMarker() here always reports MISSING even when the real,
      // apply-path-relevant marker is present.
      nginxMarkerOk = !!file && hasHashMarker(file.content, 'SECURITY-HEADERS');
      console.log(`\n-- NGINX SECURITY-HEADERS MARKER (${nginxPath}) -- ${nginxMarkerOk ? 'present' : 'MISSING (fatal — must be hand-placed; see generators/security-headers.js)'}`);
    } catch (err) {
      console.warn(`\n-- NGINX SECURITY-HEADERS MARKER (${nginxPath}) -- could not check: ${err.message}`);
    }
  } else {
    console.log('\n-- NGINX SECURITY-HEADERS MARKER -- url_file_map.siteRoot.nginxConfig not configured, skipping.');
  }

  // Dedicated analytics-install check — sitewide (layoutTemplate + a single
  // defaults.placements entry), not per-page; see the ACTION_TYPES comment
  // above for why this can't just be another entry in that loop.
  const layoutPath = resolveSiteRootFile(site, 'layoutTemplate');
  let analyticsInstallGap = null; // null = nothing to report
  if (!layoutPath) {
    analyticsInstallGap = 'no-file-mapping';
    console.log('\n-- ANALYTICS-INSTALL (sitewide) -- url_file_map.siteRoot.layoutTemplate not configured (fatal — needed before this can ever apply).');
  } else {
    // Each provider (ga4/facebook-pixel) has its own field/marker — see
    // ANALYTICS_PROVIDER_FIELDS (marker-merge.js) — so both can be
    // configured and applied without one clobbering the other's marker.
    // This checks whatever's actually configured; a provider whose field
    // isn't in analyticsMarkers yet just won't be able to apply, same as
    // "no markers configured" below, one provider at a time.
    const analyticsMarkers = resolveMarkers(site, null, 'analytics-install');
    if (!analyticsMarkers) {
      analyticsInstallGap = 'no-markers-configured';
      console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- no markers configured (add e.g. {"analyticsScriptGa4":"ANALYTICSSCRIPTGA4","analyticsScriptFacebookPixel":"ANALYTICSSCRIPTFACEBOOKPIXEL"} to url_file_map.defaults.placements["analytics-install"].markers — configure whichever provider(s) you actually use).`);
    } else {
      try {
        const file = await getFileContent(site, layoutPath, baseBranch(site));
        if (!file) {
          analyticsInstallGap = 'file-not-found';
          console.log(`\n-- ANALYTICS-INSTALL (sitewide) -- ${layoutPath} not found in repo.`);
        } else {
          const missing = Object.entries(analyticsMarkers).filter(([, name]) => !hasMarker(file.content, name));
          if (!missing.length) {
            console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- OK, marker(s) present.`);
          } else {
            const [field, markerName] = missing[0];
            const gap = classifyMarkerGap(field, layoutPath, file.content, DETECTORS);
            if (gap === 'self-heals') {
              console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- marker missing but self-healing (will auto-create SEOAI:${markerName} at apply time).`);
            } else {
              analyticsInstallGap = gap;
              console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- marker missing, FATAL (expected SEOAI:${markerName}, reason: ${gap}).`);
            }
          }
        }
      } catch (err) {
        console.warn(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- could not check: ${err.message}`);
      }
    }
  }

  const clean = noFileMapping.length === 0 && missingFiles.length === 0 && markersFatal.length === 0
    && nginxMarkerOk !== false && analyticsInstallGap === null && renderCapabilityGaps.length === 0
    && ACTION_TYPES.every((t) => noMarkers[t].length === 0);
  console.log(`\nSite #${siteId}: ${clean ? 'CLEAN — no gaps found.' : 'gaps found — see above.'}`);

  const gapCount = noFileMapping.length + missingFiles.length + markersFatal.length
    + (nginxMarkerOk === false ? 1 : 0)
    + (analyticsInstallGap !== null ? 1 : 0)
    + renderCapabilityGaps.length
    + ACTION_TYPES.reduce((sum, t) => sum + noMarkers[t].length, 0);
  await recordActionCenterConfigCheck(siteId, gapCount);
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

  // agent_fix_memory rows (migration 097) recorded with no generator_id are
  // structural/architectural gotchas learned from real past fixes (e.g.
  // "a page pattern may already get its schema/content computed by the
  // site's own template at build time — check before wiring a generator
  // adapter for it") rather than a single generator's prompt mistake.
  // Surfacing them here, at onboarding-audit time, is what lets a new
  // client's config get checked against issues already hit once before —
  // instead of re-discovering the same class of gap from scratch.
  for (const id of siteIds) {
    const lessons = await findRelevantMemory({ scope: 'client', siteId: id, generatorId: null, clientFacing: true, limit: 20 });
    if (lessons.length) {
      console.log(`\nKnown issues to check for site #${id} (from past fixes):`);
      for (const l of lessons) console.log(`  - ${l.problemSignature}: ${l.symptoms}`);
    }
  }

  for (const id of siteIds) await auditSite(id);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
