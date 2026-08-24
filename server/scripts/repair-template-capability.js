#!/usr/bin/env node
// Audits a site's currently-blocked recommendations, classifies each blocker
// using server/agents/lib/template-capability-repair.js, and repairs what's
// safely repairable:
//   - 'plumbing-gap'        -> writes the missing url_file_map adapter config
//                              directly (our own DB, immediately live).
//   - 'safe-capability-gap' -> derives a template patch from a real sibling
//                              route's own established pattern and opens a
//                              PR (never merges) — validated by the CLIENT'S
//                              OWN CI, not a local build (see the "Validate
//                              + PR" section below for why).
//   - 'architectural-gap'   -> left blocked; reported with a precise reason.
//
// Distinct BLOCKED RECOMMENDATIONS are deduped down to distinct CAPABILITY
// GAPS first (same route pattern + same generatorId = the same underlying
// gap, however many individual pages/finding rows it's blocking) — fixing
// one gap clears every recommendation it was blocking, and a single PR
// covers all of them instead of one PR per row.
//
// Callable two ways:
//   node server/scripts/repair-template-capability.js --site-id 1 [--dry-run]
//   import { repairTemplateCapabilitiesForSite } from this file (job.js/cron.js)
//
// This used to clone the client's repo with the `gh` CLI and run a real
// `npm ci && npm run build` locally to validate a patch before opening its
// PR — safe on a workstation with `gh` authenticated, but the production
// container has neither `gh` nor the client's own dependency tree, so that
// path would fail on every automated run. Reworked (2026-08-24) to push +
// PR through the same GitHub REST client every other implementer in this
// codebase already uses (github/client.js), and rely on the client's own
// "rendering-validation" GitHub Actions workflow (installed once via
// scripts/install-rendering-workflow.js) to build it — the same trust
// boundary rendering-gate.js's Phase 2 (checkClientBuildStatus) already
// uses for every other draft. A human reviewing the PR sees that check's
// real pass/fail on the PR page before ever merging.
import { query } from '../db.js';
import { getSiteById } from '../store/read.js';
import { updateSiteRepoConfig } from '../db.js';
import {
  getRepoTree, getFileContent, getBranchSha, createBranch, commitFilesAtomic, openPullRequest, defaultBranchName,
} from '../github/client.js';
import {
  classifyCapabilityGap, buildTemplatePatch, deriveAdapterConfig, GENERATOR_VALUE_KEYS,
} from '../agents/lib/template-capability-repair.js';
import { basename, extname } from 'node:path';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') args.siteId = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// Which URL a recommendation's page targets, with any trailing focus suffix
// this run's generators encode (geo-signals.js's `${page}::${focus}` finding
// id shape leaks into recommendation.page for some agents) stripped off.
function pageUrlOf(rec) {
  return String(rec.page).split('::')[0];
}

function pathnameOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

// Finds which url_file_map.patterns[] entry (if any) matches this page, the
// same regex-match semantics resolveAdapter/resolveFile already use
// internally — reimplemented here (not imported) only because those
// functions return a resolved VALUE, not which pattern index matched, and
// this script needs the index to group recommendations by shared blocker.
function matchingPatternIndex(site, pageUrl) {
  const patterns = site.url_file_map?.patterns || [];
  const pathname = pathnameOf(pageUrl);
  return patterns.findIndex((p) => p.match && new RegExp(p.match).test(pathname));
}

// Groups blocked recommendations into distinct CAPABILITY GAPS: same
// matched pattern + same generatorId. Recommendations that don't match any
// pattern (a per-page `pages[]` mapping instead) are grouped by exact page
// instead — still deduped by generatorId, just with a narrower blast radius.
function groupIntoCapabilityGaps(site, recs) {
  const groups = new Map();
  for (const rec of recs) {
    const pageUrl = pageUrlOf(rec);
    const patternIdx = matchingPatternIndex(site, pageUrl);
    const key = patternIdx >= 0 ? `pattern:${patternIdx}::${rec.recommendation_type}` : `page:${pageUrl}::${rec.recommendation_type}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, patternIdx: patternIdx >= 0 ? patternIdx : null, generatorId: rec.recommendation_type, recIds: [], pages: new Set(),
      });
    }
    const g = groups.get(key);
    g.recIds.push(rec.id);
    g.pages.add(pageUrl);
  }
  return [...groups.values()];
}

// Resolves the real Eleventy layout template that renders pages built from
// `dataFile`, by reading every .njk file's own front matter — never assumed
// from a naming convention.
//
// `dataFile` alone is not always a unique key: a nested route family (e.g.
// location x service) is commonly rendered from a SEPARATE, COMPUTED
// Eleventy data file that derives from the original one (real example:
// src/_data/locationServicePages.js does `import locations from
// './locations.js'` and cross-joins it against services.json) — a
// different pagination template, a different layout, same underlying data.
// Real evidence for that relationship (an actual import statement, not a
// name guess) is gathered once per run and used to pick the right candidate:
// `preferDerived` (set from the adapter's own `nestedField`, an already-real
// signal this repo's config uses for exactly this distinction) tries the
// derived collection(s) first, falling back to the direct one.
function makeTemplateResolver(site, ref, fileCache) {
  const resolutionCache = new Map();
  let derivedKeysPromise = null;

  // { dataKey: [otherDataKey, ...] } — which OTHER src/_data/*.js files
  // import this one, i.e. are a computed collection derived from it.
  async function derivedKeysOf(dataFile) {
    if (!derivedKeysPromise) {
      derivedKeysPromise = (async () => {
        const { files } = await getRepoTree(site, ref);
        const dataFiles = files.filter((f) => /^src\/_data\/.+\.js$/.test(f));
        const map = new Map();
        for (const path of dataFiles) {
          let file = fileCache.get(path);
          if (file === undefined) { file = await getFileContent(site, path, ref); fileCache.set(path, file); }
          if (!file) continue;
          const importMatches = [...file.content.matchAll(/from\s+['"]\.\/([\w.-]+)\.js['"]/g)];
          for (const [, importedBase] of importMatches) {
            const key = `src/_data/${importedBase}.js`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(basename(path, '.js'));
          }
        }
        return map;
      })();
    }
    const map = await derivedKeysPromise;
    return map.get(dataFile) || [];
  }

  async function findLayoutForKey(dataKey) {
    const { files } = await getRepoTree(site, ref);
    for (const path of files) {
      if (!path.endsWith('.njk')) continue;
      let file = fileCache.get(path);
      if (file === undefined) { file = await getFileContent(site, path, ref); fileCache.set(path, file); }
      if (!file) continue;
      const fm = file.content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const paginationMatch = fm[1].match(/pagination:\s*\n(?:[ \t]+\S.*\n)*?[ \t]+data:\s*(\S+)/);
      if (!paginationMatch || paginationMatch[1] !== dataKey) continue;
      const layoutMatch = fm[1].match(/layout:\s*(\S+)/);
      if (!layoutMatch) continue;
      const layoutPath = `src/_includes/layouts/${layoutMatch[1]}`;
      let layoutFile = fileCache.get(layoutPath);
      if (layoutFile === undefined) { layoutFile = await getFileContent(site, layoutPath, ref); fileCache.set(layoutPath, layoutFile); }
      if (!layoutFile) continue;
      return { paginationFile: path, layoutPath, source: layoutFile.content, sha: layoutFile.sha };
    }
    return null;
  }

  return async function resolveTemplateForDataFile(dataFile, { preferDerived = false } = {}) {
    const cacheKey = `${dataFile}::${preferDerived}`;
    if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);
    const dataKey = basename(dataFile, extname(dataFile));
    const derived = await derivedKeysOf(dataFile);
    const candidateKeys = preferDerived ? [...derived, dataKey] : [dataKey, ...derived];
    let result = null;
    for (const key of candidateKeys) {
      result = await findLayoutForKey(key);
      if (result) break;
    }
    resolutionCache.set(cacheKey, result);
    return result;
  };
}

// The callable core, usable both from the CLI (main() below) and from
// job.js/cron.js for unattended nightly runs across every connected site.
export async function repairTemplateCapabilitiesForSite(siteId, { dryRun = false } = {}) {
  const args = { siteId, dryRun };
  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}`);
  if (!site.repo_owner || !site.repo_name) throw new Error(`Site ${siteId} has no repo connected — nothing to repair.`);

  const { rows: recs } = await query(
    `SELECT id, page, recommendation_type, blocked_reason, blocked_kind
     FROM recommendations WHERE site_id = $1 AND status = 'open' AND blocked_reason IS NOT NULL`,
    [siteId]
  );

  const report = {
    plumbingGapsFixed: [], safeCapabilityGapsRepaired: [], architecturalGapsBlocked: [],
    filesChanged: [], prsCreated: [], refusals: [],
  };

  if (!recs.length) {
    console.log('No blocked open recommendations for this site. Nothing to do.');
    return report;
  }

  const groups = groupIntoCapabilityGaps(site, recs);
  console.log(`${recs.length} blocked recommendation(s) -> ${groups.length} distinct capability gap(s).`);

  const ref = defaultBranchName(site);
  const fileCache = new Map();
  const resolveTemplateForDataFile = makeTemplateResolver(site, ref, fileCache);

  // Accumulates url_file_map.patterns[] edits across every 'plumbing-gap' AND
  // 'safe-capability-gap' group before writing ONCE at the end — writing
  // per-group would race each group's read of the same site.url_file_map
  // against the others' unsaved edits.
  const patternsCopy = JSON.parse(JSON.stringify(site.url_file_map?.patterns || []));
  let urlFileMapDirty = false;

  // One branch/commit/PR per data family (dataFile), not per gap — several
  // gaps sharing the same sibling relationship (e.g. author-byline AND
  // freshness-date both missing the same expandedContent-shaped slot on the
  // same route) get folded into ONE template edit, since they're really the
  // same missing plumbing, not two.
  const pendingTemplateEdits = new Map(); // layoutPath -> { source, sha, appliedGaps: [] }

  for (const group of groups) {
    const pattern = group.patternIdx != null ? site.url_file_map.patterns[group.patternIdx] : null;
    const existingAdapterEntry = pattern?.adapters ? Object.values(pattern.adapters)[0] : null;
    const valueKey = GENERATOR_VALUE_KEYS[group.generatorId];

    if (!pattern || !existingAdapterEntry?.dataFile || !valueKey) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: !pattern
          ? 'No url_file_map pattern matches these pages at all — this is a per-page mapping gap, not a template capability question. Needs a human to add a mapping.'
          : `No existing adapter data-file reference on this route, or generatorId "${group.generatorId}" has no known rendered-value key — cannot safely derive without guessing.`,
      });
      continue;
    }

    const resolved = await resolveTemplateForDataFile(existingAdapterEntry.dataFile, { preferDerived: Boolean(existingAdapterEntry.nestedField) });
    if (!resolved) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `Could not find the Eleventy layout that renders pages built from "${existingAdapterEntry.dataFile}" — no pagination front matter in the repo references it. Needs a human to confirm which template renders this route.`,
      });
      continue;
    }

    const currentSource = pendingTemplateEdits.get(resolved.layoutPath)?.source ?? resolved.source;

    // Siblings: every OTHER pattern in this site's url_file_map whose
    // adapter references the SAME data file — the general definition of "a
    // related route family sharing this data," not a hardcoded path.
    const siblingPatterns = site.url_file_map.patterns.filter((p, idx) =>
      idx !== group.patternIdx && Object.values(p.adapters || {}).some((a) => a.dataFile === existingAdapterEntry.dataFile));
    const siblingTemplateSources = [];
    for (const sib of siblingPatterns) {
      const sibAdapter = Object.values(sib.adapters)[0];
      const sibResolved = await resolveTemplateForDataFile(sibAdapter.dataFile, { preferDerived: Boolean(sibAdapter.nestedField) });
      if (sibResolved && sibResolved.layoutPath !== resolved.layoutPath) {
        siblingTemplateSources.push({ label: sibResolved.layoutPath, source: pendingTemplateEdits.get(sibResolved.layoutPath)?.source ?? sibResolved.source });
      }
    }

    const hasAdapterConfig = Boolean(pattern.adapters?.[group.generatorId]);
    const gap = classifyCapabilityGap({
      templateSource: currentSource, siblingTemplateSources, generatorId: group.generatorId, hasAdapterConfig,
    });

    if (gap.classification === 'already-wired') {
      // Shouldn't normally happen (it wouldn't be blocked), but if it does,
      // there's nothing to repair — leave it for the next recommendation
      // sync to notice the config already resolves.
      continue;
    }

    if (gap.classification === 'plumbing-gap') {
      const fieldName = gap.ownSlot.fieldExpr.split('.').pop();
      const derived = deriveAdapterConfig(existingAdapterEntry, { generatorId: group.generatorId, valueKey, fieldName });
      patternsCopy[group.patternIdx].adapters = { ...patternsCopy[group.patternIdx].adapters, [group.generatorId]: derived };
      urlFileMapDirty = true;
      report.plumbingGapsFixed.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        pattern: pattern.match, adapterConfig: derived,
      });
      continue;
    }

    if (gap.classification === 'safe-capability-gap') {
      const targetBaseVar = existingAdapterEntry.nestedField
        ? 'serviceContent' // matches the established local variable this repo's own sibling templates already use for a nestedField-scoped object; see location-service.njk's `{% set serviceContent = ... %}` — a real convention, not invented here.
        : (currentSource.match(/\{%\s*for\s+(\w+)\s+in\s+\w+\s*%\}/)?.[1] || 'item');
      let patched;
      try {
        patched = buildTemplatePatch(currentSource, gap, targetBaseVar);
      } catch (err) {
        report.architecturalGapsBlocked.push({
          generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
          reason: `A sibling route (${gap.siblingLabel}) already solved this exact generator, but ${resolved.layoutPath} has no AI-managed slot of its own to anchor the new one after, so inserting it would require guessing a position. ${err.message}`,
        });
        continue;
      }
      pendingTemplateEdits.set(resolved.layoutPath, {
        source: patched, sha: resolved.sha,
        appliedGaps: [...(pendingTemplateEdits.get(resolved.layoutPath)?.appliedGaps || []), group],
      });
      const fieldName = gap.siblingSlot.fieldExpr.split('.').pop();
      const derived = deriveAdapterConfig(existingAdapterEntry, { generatorId: group.generatorId, valueKey, fieldName });
      patternsCopy[group.patternIdx].adapters = { ...patternsCopy[group.patternIdx].adapters, [group.generatorId]: derived };
      urlFileMapDirty = true;
      report.safeCapabilityGapsRepaired.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        pattern: pattern.match, derivedFrom: gap.siblingLabel, templateFile: resolved.layoutPath, adapterConfig: derived,
      });
      continue;
    }

    // architectural-gap
    report.architecturalGapsBlocked.push({
      generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
      reason: `No existing template slot for "${group.generatorId}" on ${resolved.layoutPath}, and no sibling route in this site has ever solved it either — there is no established pattern to safely derive from. This needs a human decision: where should this content render, and does that require a new UX section?`,
    });
  }

  // ---- Push + PR the template edits (if any), BEFORE touching our own DB ----
  //
  // No local clone, no local build — this pushes real content straight
  // through the same GitHub REST client every other implementer in this
  // codebase already uses, and lets the CLIENT's own CI (the
  // "rendering-validation" GitHub Actions workflow, installed once via
  // scripts/install-rendering-workflow.js) build and report back on the
  // PR itself, same trust boundary as rendering-gate.js's Phase 2
  // (checkClientBuildStatus) for every other draft. A failed build shows up
  // as a failed check on the PR — visible to the human who reviews it
  // before merging, never silently hidden, just not pre-empted locally.
  if (pendingTemplateEdits.size) {
    if (!args.dryRun) {
      const branchName = `action-center/template-capability-repair-${new Date().toISOString().slice(0, 10)}`;
      const fromSha = await getBranchSha(site, ref);
      await createBranch(site, branchName, fromSha);
      const files = [...pendingTemplateEdits.entries()].map(([path, edit]) => ({ path, content: edit.source }));
      await commitFilesAtomic(site, branchName, files,
        'Add AI-managed content slot(s), derived from an existing sibling route\n\nOpened by the Action Center\'s template capability repair — never auto-merged.');
      const gapSummaries = [...pendingTemplateEdits.values()].flatMap((e) => e.appliedGaps)
        .map((g) => `- \`${g.generatorId}\` on pattern \`${site.url_file_map.patterns[g.patternIdx].match}\` (${g.pages.size} page(s))`).join('\n');
      const pr = await openPullRequest(site, {
        branch: branchName,
        title: 'Add AI-managed content slot(s) for previously-blocked recommendations',
        body: `Automatically derived from an existing sibling route's own established AI-managed-slot pattern in this repo — no new architecture introduced, no fabricated content, no routing changes.\n\nThis unblocks:\n${gapSummaries}\n\n**This PR does not merge itself, and its build has not been validated locally** — check this PR's own CI status before merging. Once merged, the corresponding recommendations become draftable in the Action Center.`,
      });
      report.prsCreated.push({ url: pr.url, number: pr.number, files: files.map((f) => f.path) });
      report.filesChanged.push(...files.map((f) => f.path));
    } else {
      console.log('[dry-run] Would open a PR with:', [...pendingTemplateEdits.keys()]);
    }
  }

  // ---- Write our own config (plumbing-gap fixes, and safe-capability-gap adapter wiring) ----
  if (urlFileMapDirty && !args.dryRun) {
    await updateSiteRepoConfig({ siteId: site.id, urlFileMap: { ...site.url_file_map, patterns: patternsCopy } });
    console.log('Wrote updated url_file_map adapter config.');
  } else if (urlFileMapDirty) {
    console.log('[dry-run] Would write updated url_file_map adapter config.');
  }

  return report;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (!cliArgs.siteId) {
    console.error('Usage: node server/scripts/repair-template-capability.js --site-id <id> [--dry-run]');
    process.exit(1);
  }
  repairTemplateCapabilitiesForSite(cliArgs.siteId, { dryRun: cliArgs.dryRun }).then((report) => {
    console.log('\n=== REPAIR REPORT ===');
    console.log(JSON.stringify(report, null, 2));
  }).catch((err) => {
    console.error('repair-template-capability failed:', err);
    process.exit(1);
  });
}

export { groupIntoCapabilityGaps, matchingPatternIndex, pageUrlOf };
