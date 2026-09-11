import 'dotenv/config';
import { pool, recordActionCenterConfigCheck } from '../db.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { resolveFile, resolveMarkers, resolveAdapter, resolveSiteRootFile, resolveAuthorAvatars } from '../implementers/lib/url-file-map.js';
import { parseSvgDimensions, classifyAvatarAspectGap } from '../implementers/lib/avatar-aspect-check.js';
import { hasMarker, classifyMarkerGap } from '../implementers/lib/marker-merge.js';
import { hasHashMarker } from '../implementers/lib/hash-marker-merge.js';
import { detectInsertionPoint, detectHeadRegion } from '../implementers/lib/structural-detect.js';
import { resolveCapability, extensionOf } from '../implementers/lib/rendering-gate.js';
import { ownDomains, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent, getDefaultBranchSha } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { findRelevantMemory } from '../agent-memory.js';
import { fetchHtml } from '../agents/lib/page-content.js';

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

// Every net-new-content action type a recommendation agent can generate for
// ANY site, regardless of what this particular site's keyword/GSC data
// happens to surface at onboarding time — unlike ACTION_TYPES above, these
// have no existing page to check a marker against; the only real question is
// whether url_file_map.newContentTargets has an entry to write one to at
// all. Not knowing in advance which of these a site's growth agents will
// eventually ask for is exactly why this has to be a proactive checklist
// run once at onboarding rather than a per-recommendation surprise: Admizz
// (site 8862) onboarded with only landing-page/cookie-policy/terms-of-service
// configured, and its first blog-outline/direct-answer/translation
// recommendations sat blocked with "no url_file_map.newContentTargets[...]
// configured" for days before anyone noticed (2026-09-11).
const NEW_CONTENT_ACTION_TYPES = [
  'landing-page', 'blog-outline', 'direct-answer', 'translation',
  'cookie-policy', 'privacy-policy', 'terms-of-service',
];

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

// A `fatal-no-head-region` verdict on `openGraph` means "this file has no
// detectable per-page head region to splice a marker into" — it does NOT
// mean OG tags are actually broken on the live site. Real, opposite cases
// confirmed 2026-09-11 on two shared-layout (Eleventy) sites with the
// identical audit symptom: zunkireelabs.com's base.njk already renders
// correct og:title/og:description automatically from the same title/
// description front matter meta-title manages (curl confirmed; zero
// open-graph drafts have ever failed in the drafts table) — a false
// positive, nothing to fix. chayceproperties.com had zero og:* tags at all
// on the live page — a real gap. Same "fatal" reason, opposite ground
// truth, and nothing about url_file_map's static config can tell them
// apart — only the live page can. This is that check, automated, so a
// future onboarding doesn't have to rediscover the distinction by hand
// (see the action-center-onboarding skill's §7 for the full story).
//
// Deliberately narrow: only ever runs for `openGraph` gaps classified
// `fatal-no-head-region` (the one case this ambiguity applies to), never
// downgrades any other field or reason, and fails closed on any fetch
// error or missing/empty tag — an unverifiable page stays reported fatal,
// same "never guess" discipline as every other check in this script.
const OG_LIVE_CHECK_CONCURRENCY = 4;

function extractMetaContent(html, property) {
  const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content && content.trim() ? content.trim() : null;
}

async function verifyLiveOpenGraph(pageUrl) {
  const fetched = await fetchHtml(pageUrl);
  if (!fetched.ok) return { ok: false, reason: fetched.error };
  const title = extractMetaContent(fetched.html, 'og:title');
  const description = extractMetaContent(fetched.html, 'og:description');
  if (!title || !description) return { ok: false, reason: `live page missing ${!title ? 'og:title' : 'og:description'}` };
  return { ok: true, title, description };
}

// Batches with bounded concurrency rather than Promise.all on the whole
// list — this can run against 100+ pages on a large site, and courtesy to
// the live target (and this script's own runtime) matters more than
// shaving a few seconds off an on-demand audit.
async function verifyLiveOpenGraphBatch(entries) {
  const results = new Map();
  let i = 0;
  async function worker() {
    while (i < entries.length) {
      const entry = entries[i++];
      results.set(entry.page, await verifyLiveOpenGraph(entry.page));
    }
  }
  await Promise.all(Array.from({ length: Math.min(OG_LIVE_CHECK_CONCURRENCY, entries.length) }, worker));
  return results;
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

  // Credential check FIRST, before anything else this audit does — every
  // section below makes its own authenticated GitHub calls and silently
  // degrades a dead credential into a wall of "file not found"/"could not
  // check" noise (getFileContent swallows the error into `false`/warnings
  // per-path, since a genuinely missing file has to look the same as one
  // this audit couldn't read). A human onboarding a site, or an agent about
  // to start generating recommendations for it, needs this as one clear
  // PASS/FAIL up front, not inferred from which of thirty file checks
  // happened to fail. Real incident, site 8864 (2026-09-11): 18
  // recommendations sat blocked on "GitHub credentials are missing or no
  // longer valid" without this ever being checked as its own first step.
  let credentialsOk = false;
  try {
    await getDefaultBranchSha(site);
    credentialsOk = true;
  } catch (err) {
    console.log(`\n-- GITHUB CREDENTIALS -- FAIL: ${err.message}`);
    console.log('   Every other section below will misreport as missing files/markers until this is fixed — resolve this first, then re-run.');
  }
  if (credentialsOk) console.log('\n-- GITHUB CREDENTIALS -- OK, repo reachable.');

  const { start, end } = defaultRange();
  const rawPages = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_LIMIT);
  // A domain-level GSC property (sc-domain:...) returns pages from every
  // subdomain it has data for, including unrelated products on the same
  // root domain (see agents/lib/site-domain.js) — filtered the same way
  // selectCandidatePages/ai-recommendation.js already do, so this audit's
  // "real candidate pages" pool matches what the actual recommendation
  // agents use, not raw unfiltered GSC data.
  const pages = filterOwnDomainPages(rawPages, ownDomains(site));
  const pageUrls = pages.map((p) => p.dim_value);
  if (rawPages.length !== pages.length) {
    console.log(`(filtered ${rawPages.length - pages.length} page(s) from other subdomains — own domains: ${(ownDomains(site) || []).join(', ') || '(none configured)'})`);
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
  let markersFatal = markersMissing.filter((m) => m.gap !== 'self-heals');

  // See verifyLiveOpenGraph's own comment above for why this exists: a
  // `fatal-no-head-region` verdict on openGraph specifically can't be
  // trusted without checking the live page, since a shared layout can
  // legitimately auto-derive OG tags from an already-managed field. One
  // fetch per unique live URL among the candidates, not per (field) row.
  const ogFatalCandidates = markersFatal.filter((m) => m.markerField === 'openGraph' && m.gap === 'fatal-no-head-region');
  const ogLiveVerifiedOk = [];
  if (ogFatalCandidates.length) {
    const uniquePages = [...new Map(ogFatalCandidates.map((m) => [m.page, m])).values()];
    const liveResults = await verifyLiveOpenGraphBatch(uniquePages);
    markersFatal = markersFatal.filter((m) => {
      if (!(m.markerField === 'openGraph' && m.gap === 'fatal-no-head-region')) return true;
      const result = liveResults.get(m.page);
      if (result?.ok) { ogLiveVerifiedOk.push({ ...m, live: result }); return false; }
      return true; // fetch failed or tags missing/empty — stays reported fatal, never guessed clean
    });
  }

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

  console.log(`\n-- OPEN GRAPH LIVE-VERIFIED OK, not fatal (${ogLiveVerifiedOk.length}) -- (no per-page marker exists, but the live page already has correct og:title/og:description — likely auto-derived by the shared layout; nothing to fix)`);
  for (const { page, filePath } of ogLiveVerifiedOk) {
    console.log(`  ${page} -> ${filePath}`);
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

  // Coverage, not correctness: which net-new content types this site has NO
  // target for at all. Not fatal by design — a site may genuinely never need
  // e.g. translation — but it must be a visible, explicit choice made once
  // at onboarding ("configure it now, or accept these will block later"),
  // not a gap nobody looked at until a recommendation for it showed up
  // blocked. See NEW_CONTENT_ACTION_TYPES above for the real incident this
  // closes.
  const missingContentTargets = NEW_CONTENT_ACTION_TYPES.filter((t) => !newContentTargets[t]);
  console.log(`\n-- NEW CONTENT TARGETS NOT CONFIGURED (${missingContentTargets.length}/${NEW_CONTENT_ACTION_TYPES.length}) -- (not fatal; any recommendation of this type will block until configured)`);
  for (const actionType of missingContentTargets) console.log(`  [${actionType}] no url_file_map.newContentTargets["${actionType}"] entry`);
  if (!missingContentTargets.length) console.log('  OK — every known net-new content type has a target configured.');

  // Author/org avatar aspect-ratio check (avatar-aspect-check.js) — catches
  // the zunkireelabs-web incident shape (a wide wordmark logo declared as
  // rendering inside a circular object-cover avatar frame, which crops it
  // to an unrecognizable sliver) at onboarding time, before any blog post
  // ships. Purely config-driven: a site with no siteRoot.authorAvatars
  // declared has nothing to check here, same as every other optional
  // section of this audit.
  const authorAvatars = resolveAuthorAvatars(site);
  const avatarAspectFatal = []; // { label, imagePath, reason }
  const avatarAspectUnverified = []; // { label, imagePath, reason }
  for (const avatar of authorAvatars) {
    if (!avatar?.imagePath) continue;
    let dimensions = null;
    try {
      const file = await getFileContent(site, avatar.imagePath, baseBranch(site));
      if (!file) {
        avatarAspectFatal.push({ label: avatar.label, imagePath: avatar.imagePath, reason: 'file not found in repo' });
        continue;
      }
      if (avatar.imagePath.toLowerCase().endsWith('.svg')) dimensions = parseSvgDimensions(file.content);
    } catch (err) {
      console.warn(`  (could not check avatar ${avatar.imagePath}: ${err.message})`);
      continue;
    }
    const gap = classifyAvatarAspectGap({ expectedFit: avatar.expectedFit, dimensions });
    if (!gap) continue;
    const entry = { label: avatar.label, imagePath: avatar.imagePath, reason: gap.reason };
    if (gap.severity === 'fatal') avatarAspectFatal.push(entry);
    else avatarAspectUnverified.push(entry);
  }
  console.log(`\n-- AUTHOR AVATAR ASPECT-RATIO GAPS (${avatarAspectFatal.length}) -- (a non-square logo/avatar declared as rendering inside a circular crop frame)`);
  for (const { label, imagePath, reason } of avatarAspectFatal) console.log(`  ${label || imagePath} (${imagePath}): ${reason}`);
  if (avatarAspectUnverified.length) {
    console.log(`\n-- AUTHOR AVATAR ASPECT-RATIO, UNVERIFIED (${avatarAspectUnverified.length}) -- (declared circular-cover but this audit can't determine real dimensions — check by eye)`);
    for (const { label, imagePath, reason } of avatarAspectUnverified) console.log(`  ${label || imagePath} (${imagePath}): ${reason}`);
  }
  if (authorAvatars.length && !avatarAspectFatal.length && !avatarAspectUnverified.length) {
    console.log('  OK — every declared circular-cover avatar is square enough to survive the crop.');
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

  const clean = credentialsOk && noFileMapping.length === 0 && missingFiles.length === 0 && markersFatal.length === 0
    && nginxMarkerOk !== false && analyticsInstallGap === null && renderCapabilityGaps.length === 0
    && avatarAspectFatal.length === 0
    && ACTION_TYPES.every((t) => noMarkers[t].length === 0);
  console.log(`\nSite #${siteId}: ${clean ? 'CLEAN — no gaps found.' : 'gaps found — see above.'}`);

  const gapCount = noFileMapping.length + missingFiles.length + markersFatal.length
    + (nginxMarkerOk === false ? 1 : 0)
    + (analyticsInstallGap !== null ? 1 : 0)
    + renderCapabilityGaps.length
    + avatarAspectFatal.length
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

// Guarded like discover-url-file-map.js/bootstrap-structural-markers.js's
// own CLI entrypoints — connect-repo.js imports auditSite() as a library
// call, and without this guard that import alone re-ran this file's own
// CLI main() (parsing connect-repo's argv, auditing, and calling
// pool.end()) as a side effect, before connect-repo's own explicit
// auditSite() call and pool.end() ran — hence "Called end on pool more
// than once".
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
