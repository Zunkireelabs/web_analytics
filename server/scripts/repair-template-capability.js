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
  listOpenPullRequestsForBranch,
} from '../github/client.js';
import {
  classifyCapabilityGap, buildTemplatePatch, deriveAdapterConfig, getGeneratorValueKey, parseAiManagedSlots,
  findSlotForGenerator, fieldNameFromExpr,
} from '../agents/lib/template-capability-repair.js';
import { isOnboardingAnalysisPending } from '../implementers/lib/onboarding-readiness.js';
import { createDesignAgentJob, getDesignAgentJobById } from '../store/execution-jobs.js';
import { recordCapabilityRepair } from '../store/capability-repairs.js';
import { autoHealFileMapping } from '../implementers/lib/discover-file-mapping.js';
import { autoHealNewContentTarget } from '../implementers/lib/discover-content-target.js';
import { resolveFile, resolveNewContentTarget } from '../implementers/lib/url-file-map.js';
import { FRONTEND_ACTION_TYPES } from '../implementers/frontend.js';
import { basename, extname } from 'node:path';

// Runs one capability-repair Design Agent job through the SAME queue +
// worker.js poll loop every other Design Agent job uses (090's
// execution_jobs machinery), instead of calling openhands-handler.js's
// createCapabilityRepairHandler() directly in-process.
//
// That direct call is what this replaced, and it was a real, currently-live
// bug: this script runs inside the main app container (root Dockerfile,
// plain node:20-alpine) via server/cron.js, which has neither the Python
// venv nor the Docker socket createCapabilityRepairHandler needs — those
// exist only in design-agent-worker's own image (see its Dockerfile).
// Every architectural-gap repair attempt was failing at the Python-spawn
// step, every single day, for every eligible site, landing silently in
// architecturalGapsBlocked with a deployment-fault message no one was
// watching for.
//
// Mirrors design-drift.js's resolveOrCreateComponentTemplate
// (waitForCompletion path) exactly: enqueue via the generic
// createDesignAgentJob, then poll the job row's status rather than the
// container itself, since only design-agent-worker's own process — a
// different container — actually claims and runs it. Bounded by
// waitBudgetMs so one slow/stuck job can't hang the whole daily pass
// forever; a timeout is reported the same way a real failure is, and the
// gap is picked up again on the next run. A pass-scoped timeout (not
// caller-set retries) is correct here: this script already treats each
// gap as independent and moves on to the next one on any failure.
const CAPABILITY_REPAIR_WAIT_MS = Number(process.env.DESIGN_AGENT_WAIT_MS) || 15 * 60 * 1000;
const CAPABILITY_REPAIR_POLL_INTERVAL_MS = 5000;
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function runCapabilityRepairJob(siteId, payload, {
  enqueue = createDesignAgentJob, pollJobStatus = getDesignAgentJobById,
  sleep = defaultSleep, waitBudgetMs = CAPABILITY_REPAIR_WAIT_MS,
} = {}) {
  const queued = await enqueue(siteId, null, { params: { mode: 'capability-repair', payload } });
  const deadline = Date.now() + waitBudgetMs;
  let finished = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const job = await pollJobStatus(queued.id).catch(() => null);
    if (job && job.status !== 'queued' && job.status !== 'executing') {
      finished = job;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(CAPABILITY_REPAIR_POLL_INTERVAL_MS);
  }
  if (!finished) {
    throw new Error(`capability-repair job ${queued.id} did not finish within ${waitBudgetMs}ms — still queued or executing`);
  }
  if (finished.status !== 'completed') {
    throw new Error(finished.result?.failure?.message || `capability-repair job ${queued.id} failed`);
  }
  return finished.result;
}

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

// Real evidence for the 'architectural-gap' case (no slot on this template,
// no sibling route sharing its data file either) — scans EVERY .njk file in
// the repo, not just same-data-file siblings, for a real AI-managed slot
// this exact generatorId already uses ANYWHERE in the site, as proof of how
// this site expresses that specific kind of content. Falls back to any
// AI-managed slot at all (a different generator) purely as a markup-shape
// example when no exact match exists. Returns [] — never a fabricated
// example — when the site has no AI-managed slot anywhere. Deliberately a
// much wider net than classifyCapabilityGap's own sibling search: that one
// only trusts a match specific enough to clone directly and wire up
// automatically; this one is evidence handed to the Design Agent to READ
// and adapt, appropriate only because a human-equivalent review (the PR
// this eventually produces) still stands between it and being merged.
async function findConventionExamples(site, ref, generatorId, {
  getRepoTreeFn = getRepoTree, getFileContentFn = getFileContent, fileCache = new Map(), limit = 2,
} = {}) {
  const { files } = await getRepoTreeFn(site, ref);
  const njkFiles = files.filter((f) => f.endsWith('.njk'));
  const exact = [];
  const any = [];
  for (const path of njkFiles) {
    let file = fileCache.get(path);
    if (file === undefined) { file = await getFileContentFn(site, path, ref); fileCache.set(path, file); }
    if (!file) continue;
    for (const slot of parseAiManagedSlots(file.content)) {
      const example = { path, snippet: slot.raw };
      if (slot.generatorId === generatorId) exact.push(example);
      else if (slot.isAiManaged) any.push(example);
    }
    if (exact.length >= limit) break;
  }
  return (exact.length ? exact : any).slice(0, limit);
}

// The callable core, usable both from the CLI (main() below) and from
// job.js/cron.js for unattended nightly runs across every connected site.
export async function repairTemplateCapabilitiesForSite(siteId, {
  dryRun = false,
  onboardingAnalysisPending = isOnboardingAnalysisPending,
} = {}) {
  const args = { siteId, dryRun };
  let site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}`);
  if (!site.repo_owner || !site.repo_name) throw new Error(`Site ${siteId} has no repo connected — nothing to repair.`);

  // Two-stage onboarding: computed once per run (not per gap group below) —
  // a genuinely new tenant's repo connection queues ONLY the whole-site
  // analysis job, and the live architectural-gap branch further down must
  // not open a single PR until that analysis is terminal. See
  // isOnboardingAnalysisPending's own comment (design-drift.js) for exactly
  // what "pending" means and why an existing, already-running tenant is
  // never newly blocked by it.
  const onboardingPending = await onboardingAnalysisPending(site);

  const { rows: recs } = await query(
    `SELECT id, page, recommendation_type, blocked_reason, blocked_kind
     FROM recommendations WHERE site_id = $1 AND status = 'open' AND blocked_reason IS NOT NULL`,
    [siteId]
  );

  const report = {
    plumbingGapsFixed: [], safeCapabilityGapsRepaired: [], architecturalGapsBlocked: [],
    // A true architectural-gap group for which real evidence (the target
    // template/data file's own current content, plus whatever real
    // AI-managed-slot convention this site already uses elsewhere, if any)
    // could be gathered — dryRun reports the constructed capability-repair
    // task payload here without dispatching it; a live run would queue it
    // as a design_generate job in 'capability-repair' mode instead of
    // leaving the group in architecturalGapsBlocked.
    architecturalGapsWithDerivedTask: [],
    // Live-run counterpart to the above: a capability-repair job actually
    // ran, its build passed, and its resulting slot was independently
    // re-verified (never trusted from the agent's own self-report) — its
    // two file edits are folded into pendingTemplateEdits below, same PR
    // as any other gap fixed in this run.
    architecturalGapsRepaired: [],
    // Page-level (not pattern-family) file-mapping gaps healed via
    // autoHealFileMapping — PASS 0 below. List of page URLs.
    pageMappingsHealed: [],
    // Net-new-content generatorIds (FRONTEND_ACTION_TYPES) healed via
    // autoHealNewContentTarget — PASS 0b below. List of actionType strings.
    contentTargetsHealed: [],
    filesChanged: [], prsCreated: [], refusals: [],
  };

  if (!recs.length) {
    console.log('No blocked open recommendations for this site. Nothing to do.');
    return report;
  }

  const groups = groupIntoCapabilityGaps(site, recs);
  console.log(`${recs.length} blocked recommendation(s) -> ${groups.length} distinct capability gap(s).`);

  // PASS 0 — page-level file-mapping gaps, distinct from the pattern-family
  // template/adapter gaps the rest of this function handles. Every group
  // below with no matching url_file_map PATTERN was previously reported as
  // an unconditional "needs a human" architectural gap — but a page can
  // also resolve through url_file_map.PAGES (a separate, per-exact-URL
  // map), and this function never checked that at all, so a page already
  // healed by autoHealFileMapping's own live gate (recommendation-gates.js)
  // — or healable right now — was reported as blocked regardless.
  //
  // Reuses autoHealFileMapping exactly as-is (the same evidence tiers,
  // foreign-domain/non-primary-host protection, and capability_repairs
  // audit trail recommendation-gates.js's live gate and routes/
  // action-center.js's on-demand heal already use) — never a parallel
  // implementation. Sequential, not parallel, and followed by a fresh
  // re-fetch of `site` before patternsCopy/pagesCopy are derived from it
  // below, so this pass's own url_file_map.pages writes can never be lost
  // to this function's own later url_file_map.patterns write (the two are
  // sibling keys of the same JSON column — a stale-snapshot overwrite of
  // one silently reverting the other is a real, confirmed-live failure
  // mode, not a hypothetical one).
  const distinctUnmappedPages = [...new Set(
    groups.filter((g) => g.patternIdx == null).flatMap((g) => [...g.pages])
  )].filter((pageUrl) => pageUrl && !resolveFile(site, pageUrl));

  const pageMappingsHealed = [];
  const pageMappingsStillGap = [];
  if (distinctUnmappedPages.length && !dryRun) {
    for (const pageUrl of distinctUnmappedPages) {
      const actionType = recs.find((r) => pageUrlOf(r) === pageUrl)?.recommendation_type;
      const healedConfig = await autoHealFileMapping(site, pageUrl, actionType).catch((err) => {
        console.warn(`[repair-template-capability] auto-heal threw for ${pageUrl}: ${err.message}`);
        return null;
      });
      if (healedConfig) pageMappingsHealed.push(pageUrl);
      else pageMappingsStillGap.push(pageUrl);
    }
    if (pageMappingsHealed.length) {
      site = await getSiteById(siteId); // refresh — see comment above
      console.log(`Auto-healed ${pageMappingsHealed.length} page-level file mapping(s): ${pageMappingsHealed.join(', ')}`);
    }
  } else if (distinctUnmappedPages.length) {
    pageMappingsStillGap.push(...distinctUnmappedPages);
    console.log(`[dry-run] Would attempt to auto-heal ${distinctUnmappedPages.length} page-level file mapping(s) via autoHealFileMapping: ${distinctUnmappedPages.join(', ')}`);
  }
  report.pageMappingsHealed = pageMappingsHealed;

  // PASS 0b — newContentTargets gaps: a DIFFERENT capability than the
  // page-file mapping Pass 0 heals above. Some blocked generatorIds (real
  // example: blog-outline) create NET-NEW content with no existing page to
  // map at all — their recommendation's "page" field holds a topic/slug,
  // not a URL — and are blocked on url_file_map.newContentTargets[actionType]
  // (where in the repo to create the new file) being unconfigured, not on
  // any per-page mapping. Reuses autoHealNewContentTarget exactly as-is —
  // the SAME function recommendation-gates.js's own live gate already
  // calls (evidence: a directory with 3+ same-extension content files,
  // narrowed by the actionType's own naming convention only when more than
  // one directory qualifies; never invented, never applied to an actionType
  // this repo doesn't actually have such a directory for).
  //
  // Scoped to FRONTEND_ACTION_TYPES (the same canonical net-new-whole-page
  // generatorId list design-drift.js's own componentTemplateActionTypeFor
  // already uses) — never attempted for every blocked generatorId
  // indiscriminately: autoHealNewContentTarget has no way to know WHETHER a
  // given actionType is conceptually a net-new-content generator at all, so
  // calling it for one that isn't (e.g. "faq", which decorates an existing
  // page) risks assigning it a real content directory it should never have.
  const blockedActionTypesNeedingContentTarget = [...new Set(
    recs.map((r) => r.recommendation_type).filter((t) => FRONTEND_ACTION_TYPES.has(t))
  )].filter((actionType) => !resolveNewContentTarget(site, actionType, 'probe'));

  const contentTargetsHealed = [];
  if (blockedActionTypesNeedingContentTarget.length && !dryRun) {
    for (const actionType of blockedActionTypesNeedingContentTarget) {
      const healedConfig = await autoHealNewContentTarget(site, actionType).catch((err) => {
        console.warn(`[repair-template-capability] newContentTargets auto-heal threw for "${actionType}": ${err.message}`);
        return null;
      });
      if (healedConfig) contentTargetsHealed.push(actionType);
    }
    if (contentTargetsHealed.length) {
      site = await getSiteById(siteId); // refresh — same race-avoidance reasoning as Pass 0 above
      console.log(`Auto-healed newContentTargets for: ${contentTargetsHealed.join(', ')}`);
    }
  } else if (blockedActionTypesNeedingContentTarget.length) {
    console.log(`[dry-run] Would attempt to auto-heal newContentTargets via autoHealNewContentTarget for: ${blockedActionTypesNeedingContentTarget.join(', ')}`);
  }
  report.contentTargetsHealed = contentTargetsHealed;

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
    const valueKey = getGeneratorValueKey(group.generatorId);

    // A page whose FILE already resolves (via url_file_map.pages, a
    // naming-convention match resolveFile derives on its own, or PASS 0's
    // own heal above) has nothing left for this function to fix, no matter
    // whether the PATTERN that happens to regex-match its URL (if any)
    // carries a data-array-content adapter. Most generators (faq,
    // expand-content, schema, canonical, ...) render through a plain
    // per-file marker splice, which needs no adapter at all — only
    // data-array-content routes (locations/glossary/compare-shaped
    // families) do. Checked BEFORE the pattern/adapter checks below, not
    // just inside the no-pattern branch: a page can match a pattern
    // registered for a COMPLETELY UNRELATED generatorId's adapter (real
    // case: zunkireelabs-web's own generic /resources/([^/]+)/?$ pattern)
    // while its own file resolves through a totally different, adapter-free
    // path — the pattern match is irrelevant to whether THIS recommendation
    // is actually blocked. Its blocked_reason (if it still says otherwise)
    // is simply stale and will clear on the next sync.
    const alreadyResolvedPage = [...group.pages].find((p) => resolveFile(site, p));
    if (alreadyResolvedPage) continue;

    // A net-new-content generatorId (FRONTEND_ACTION_TYPES) whose
    // newContentTargets entry now resolves (PASS 0b above, or already
    // configured before this run) has nothing left to fix here either —
    // its "page" is a topic/slug, never a real URL, so alreadyResolvedPage
    // above can never catch it; this is its own, separate resolution check.
    if (FRONTEND_ACTION_TYPES.has(group.generatorId) && resolveNewContentTarget(site, group.generatorId, 'probe')) continue;

    if (!pattern) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: pageMappingsStillGap.some((p) => group.pages.has(p))
          ? 'No url_file_map pattern OR page mapping matches these pages, and autoHealFileMapping could not safely resolve one either (see capability_repairs for the specific reason: foreign-domain, non-primary-host, or ambiguous/no-candidate evidence) — needs a human to add a mapping.'
          : 'No url_file_map pattern matches these pages at all — this is a per-page mapping gap, not a template capability question. Needs a human to add a mapping.',
      });
      continue;
    }
    if (!existingAdapterEntry?.dataFile || !valueKey) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `No existing adapter data-file reference on this route, or generatorId "${group.generatorId}" has no known rendered-value key — cannot safely derive without guessing.`,
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

    // architectural-gap: no slot on this template, no sibling route sharing
    // this data file either. Rather than stopping here, gather real
    // evidence (this template's/data file's own current content, plus
    // whatever AI-managed-slot convention this site already uses ANYWHERE,
    // if it ever has) and construct the capability-repair task a Design
    // Agent job would run — dryRun reports it without dispatching one.
    const dataFileContent = fileCache.has(existingAdapterEntry.dataFile)
      ? fileCache.get(existingAdapterEntry.dataFile)
      : await getFileContent(site, existingAdapterEntry.dataFile, ref).then((f) => { fileCache.set(existingAdapterEntry.dataFile, f); return f; });

    if (!dataFileContent) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `No existing template slot for "${group.generatorId}" on ${resolved.layoutPath}, no sibling route in this site has ever solved it either, and ${existingAdapterEntry.dataFile} (the data file this route's adapter references) could not even be read to gather evidence for a derived repair.`,
      });
      continue;
    }

    const conventionExamples = await findConventionExamples(site, ref, group.generatorId, { fileCache });
    const derivedTaskPayload = {
      generatorId: group.generatorId,
      valueKey,
      templatePath: resolved.layoutPath,
      templateSource: currentSource,
      dataFilePath: existingAdapterEntry.dataFile,
      dataFileSource: dataFileContent.content,
      conventionExamples,
    };

    // Same real-repo-edit/PR consent gate as every other autonomous path
    // that touches a client's actual repo (queueDesignAgentDerivationForSite,
    // resolveOrCreateComponentTemplate) — auto_remediation_enabled, not a
    // separate flag. Checked here rather than once at the top of the
    // function so dry-run still reports honestly which gaps a live run
    // would actually be allowed to repair, instead of a "would queue" claim
    // this site isn't eligible for.
    if (!site.auto_remediation_enabled) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `A capability-repair Design Agent job could derive a fix for "${group.generatorId}" on ${resolved.layoutPath}, but this site has not been through its one-time auto-remediation review (auto_remediation_enabled is off) — no autonomous edit to the client's real repo will run until that consent is granted.`,
      });
      continue;
    }

    // Two-stage onboarding: this site's whole-site analysis (queued at
    // connect-repo time) hasn't reached a terminal state yet — repair
    // execution waits for whatever LATER cron pass finds it done, never
    // runs the same pass regardless of completion. Checked here (not just
    // once at the top) for the same dry-run-honesty reason as the
    // auto_remediation_enabled check just above.
    if (onboardingPending) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `A capability-repair Design Agent job could derive a fix for "${group.generatorId}" on ${resolved.layoutPath}, but this site's initial onboarding analysis is still in progress — no autonomous edit to the client's real repo will run until that analysis finishes. This will resolve itself automatically on a later scheduled run.`,
      });
      continue;
    }

    if (dryRun) {
      report.architecturalGapsWithDerivedTask.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        pattern: pattern.match, templateFile: resolved.layoutPath, dataFile: existingAdapterEntry.dataFile,
        conventionExampleCount: conventionExamples.length,
        derivedTaskPayload,
      });
      console.log(`[dry-run] Would queue a capability-repair Design Agent job for "${group.generatorId}" on ${resolved.layoutPath} (${conventionExamples.length ? `derived from ${conventionExamples.length} real convention example(s)` : 'no existing convention found anywhere in this site — agent must propose the minimal shape'}).`);
      continue;
    }

    // LIVE execution — a real Design Agent capability-repair job, run
    // in-process (this is a real container job: network install + a real
    // client build, minutes not seconds, same class of work as
    // safeCapabilityGapsRepaired's own template-patch derivation just
    // slower). Deliberately does NOT open its own PR: its two file edits
    // (if the repair validates) are folded into the SAME pendingTemplateEdits
    // map / SAME single PR that plumbing-gap and safe-capability-gap fixes
    // already batch into below — reusing the one existing PR step this
    // script already has, rather than a second, separate one "merely
    // because a capability repair was performed." That existing PR is the
    // human merge gate; nothing here bypasses it or writes to the client's
    // default branch directly.
    //
    // Two files could collide with an edit staged by an earlier gap in
    // THIS SAME run (rare, but the job below ran against the file's
    // content from before this loop iteration, not any not-yet-committed
    // pending edit) — skipped rather than silently clobbered; picked up
    // cleanly on the next run once the earlier edit has actually landed.
    if (pendingTemplateEdits.has(resolved.layoutPath) || pendingTemplateEdits.has(existingAdapterEntry.dataFile)) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `${resolved.layoutPath} or ${existingAdapterEntry.dataFile} already has a pending edit from another gap fixed earlier in this same run — repairing this one now could silently clobber that edit. Will be picked up on the next run.`,
      });
      continue;
    }

    let jobResult;
    try {
      jobResult = await runCapabilityRepairJob(site.id, derivedTaskPayload);
    } catch (err) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `A capability-repair Design Agent job ran but did not produce a validated repair: ${err.message}`,
      });
      await recordCapabilityRepair(site.id, {
        capabilityType: 'template-slot-derivation', target: resolved.layoutPath, outcome: 'failed',
        evidenceTier: conventionExamples.length ? 'sibling-convention' : 'no-convention-found',
        detail: { generatorId: group.generatorId, dataFile: existingAdapterEntry.dataFile, error: err.message },
      });
      continue;
    }

    // Never trusts the agent's own self-reported fieldName/baseVar — same
    // discipline as everywhere else in this codebase. Re-parses the
    // TEMPLATE FILE'S OWN RETURNED CONTENT with the exact same
    // parseAiManagedSlots this module already uses to find a real slot,
    // and only accepts a slot that (a) genuinely wasn't present before and
    // (b) is now findable for this exact generatorId — the same
    // structural evidence classifyCapabilityGap itself requires.
    const templateEdit = jobResult.filesChanged.find((f) => f.path === resolved.layoutPath);
    const dataFileEdit = jobResult.filesChanged.find((f) => f.path === existingAdapterEntry.dataFile);
    const beforeSlot = findSlotForGenerator(parseAiManagedSlots(currentSource), group.generatorId);
    const afterSlot = templateEdit ? findSlotForGenerator(parseAiManagedSlots(templateEdit.newContent), group.generatorId) : null;

    if (!templateEdit || !dataFileEdit || beforeSlot || !afterSlot) {
      report.architecturalGapsBlocked.push({
        generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
        reason: `A capability-repair Design Agent job ran and its build passed, but the resulting ${resolved.layoutPath} could not be independently verified to contain a genuine new "${group.generatorId}" slot — refusing to trust the agent's own self-report.`,
      });
      await recordCapabilityRepair(site.id, {
        capabilityType: 'template-slot-derivation', target: resolved.layoutPath, outcome: 'failed',
        evidenceTier: conventionExamples.length ? 'sibling-convention' : 'no-convention-found',
        detail: { generatorId: group.generatorId, dataFile: existingAdapterEntry.dataFile, reason: 'unverified-slot' },
      });
      continue;
    }

    const fieldName = fieldNameFromExpr(afterSlot.fieldExpr);
    const derived = deriveAdapterConfig(existingAdapterEntry, { generatorId: group.generatorId, valueKey, fieldName });
    patternsCopy[group.patternIdx].adapters = { ...patternsCopy[group.patternIdx].adapters, [group.generatorId]: derived };
    urlFileMapDirty = true;

    pendingTemplateEdits.set(resolved.layoutPath, { source: templateEdit.newContent, appliedGaps: [group] });
    pendingTemplateEdits.set(existingAdapterEntry.dataFile, { source: dataFileEdit.newContent, appliedGaps: [group] });

    report.architecturalGapsRepaired.push({
      generatorId: group.generatorId, pages: [...group.pages], recIds: group.recIds,
      pattern: pattern.match, templateFile: resolved.layoutPath, dataFile: existingAdapterEntry.dataFile,
      fieldName, adapterConfig: derived,
    });
    await recordCapabilityRepair(site.id, {
      capabilityType: 'template-slot-derivation', target: resolved.layoutPath, outcome: 'repaired',
      evidenceTier: conventionExamples.length ? 'sibling-convention' : 'no-convention-found',
      detail: { generatorId: group.generatorId, dataFile: existingAdapterEntry.dataFile, fieldName, recIds: group.recIds },
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
      // Same branch is reused for every capability-repair fix opened THIS
      // CALENDAR DAY (branchName is date-scoped, not per-run) — a second run
      // on the same day commits its own additional fix(es) onto whatever is
      // already there. GitHub 422s "a PR already exists for this head" on a
      // second openPullRequest for the same branch, so check for one first
      // and reuse it — same pattern github-ops.js's openPrForBranch/
      // openRollbackPr and install-rendering-workflow.js already use for
      // exactly this "many things can land on today's one shared branch"
      // shape, which this script had simply never adopted.
      const existingPrs = await listOpenPullRequestsForBranch(site, branchName);
      const pr = existingPrs.length
        ? { url: existingPrs[0].html_url, number: existingPrs[0].number }
        : await openPullRequest(site, {
          branch: branchName,
          title: 'Add AI-managed content slot(s) for previously-blocked recommendations',
          body: `Automatically derived — either from an existing sibling route's own established AI-managed-slot pattern in this repo, or (where no sibling existed) by a Design Agent job that inspected this repo, added the smallest new field + rendering slot, and validated it against this repo's own real build before this PR was ever opened. No fabricated content, no routing changes.\n\nThis unblocks:\n${gapSummaries}\n\n**This PR does not merge itself** — check this PR's own CI status before merging. Once merged, the corresponding recommendations become draftable in the Action Center.`,
        });
      report.prsCreated.push({ url: pr.url, number: pr.number, files: files.map((f) => f.path), reused: existingPrs.length > 0 });
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
