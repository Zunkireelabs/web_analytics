import { pageInScopeAndMapped } from './marker-setup-pages.js';
import { resolveInsertion } from './insertion-engine.js';
import { hasMarker } from './marker-merge.js';
import { resolveMarkers, resolveAdapter } from './url-file-map.js';
import { validateWriteScope } from './write-scope-gate.js';
import { validateRenderingBatch } from './rendering-gate.js';
import { baseBranch, batchBranchName } from './github-ops.js';

// Markers-only setup PR: after a repository is connected and the baseline has shown what the site needs, work out which agent
// markers (the slots the agents write titles, FAQs, schema... into) are missing from the files this site owns, and open ONE pull
// request that adds only those markers. No content, no fixes. Once a person merges it, the next scheduled run finds every marker
// present and starts applying fixes.
//
// It reuses the machinery the daily fix pipeline already trusts: resolveInsertion creates a marker only where it can find a REAL
// place for it (a safe front-matter value, an existing <head>, or structural detection of the page body) and reports everything else
// as `unresolved`, never guessing. The write-scope and rendering gates run before anything is written. It never merges.
//
// Off unless a site opts in: url_file_map.markerSetup = { enabled: true }. Idempotent: an open setup PR (or an existing setup branch)
// is reported, never duplicated. Pure of GitHub and the database except through `deps`, so every rule is tested without a network.

export const SETUP_BRANCH_PREFIX = 'action-center/markers-setup';
export const setupBranchName = (site) => `${SETUP_BRANCH_PREFIX}-${site.id}`;

export const markerSetupEnabled = (site) => site?.url_file_map?.markerSetup?.enabled === true;

// file path -> { markers: { field: markerName }, pages: [url...] }, for the pages this site owns and has mapped to a file.
export function collectTargets(site, pages, markerTypes) {
  const byFile = new Map();
  for (const page of pages) {
    const hit = pageInScopeAndMapped(site, page);
    if (!hit) continue;
    for (const actionType of markerTypes) {
      if (resolveAdapter(site, page, actionType)) continue; // adapter-routed pages own their data path; not a marker gap
      const markers = resolveMarkers(site, page, actionType);
      if (!markers) continue;
      const entry = byFile.get(hit.file) || { markers: {}, pages: [] };
      Object.assign(entry.markers, markers);
      if (!entry.pages.includes(page)) entry.pages.push(page);
      byFile.set(hit.file, entry);
    }
  }
  return byFile;
}

export async function planMarkerSetup(site, { pages, markerTypes, getFile, ref }) {
  const targets = collectTargets(site, pages, markerTypes);
  const files = []; const unresolved = []; const alreadyComplete = []; const unreadable = [];
  for (const [path, { markers, pages: filePages }] of targets) {
    let file;
    try { file = await getFile(site, path, ref); } catch (err) { unreadable.push({ path, error: err.message }); continue; }
    if (!file) { unreadable.push({ path, error: 'file not found on the base branch' }); continue; }
    const missing = Object.entries(markers).filter(([, name]) => !hasMarker(file.content, name));
    if (!missing.length) { alreadyComplete.push(path); continue; }
    const result = await resolveInsertion(site, file.content, path, Object.fromEntries(missing));
    for (const u of result.unresolved) unresolved.push({ path, pages: filePages.slice(0, 3), ...u });
    if (result.content !== file.content) files.push({ path, content: result.content });
  }
  return { files, unresolved, alreadyComplete, unreadable, filesChecked: targets.size };
}

export async function runMarkerSetup(site, deps) {
  const {
    pages, markerTypes, getFile, getBranchSha, createBranch, commitFiles, openPr, findOpenPr, open = false,
  } = deps;
  if (!markerSetupEnabled(site)) return { status: 'disabled' };
  if (!site?.repo_owner || !site?.repo_name) return { status: 'no-repo' };
  const ref = baseBranch(site);
  const branch = setupBranchName(site);

  const existing = await findOpenPr(site, branch);
  if (existing) return { status: 'already-open', prNumber: existing.number, prUrl: existing.html_url, branch };

  const plan = await planMarkerSetup(site, { pages, markerTypes, getFile, ref });
  const summary = { branch, filesChecked: plan.filesChecked, unresolved: plan.unresolved, unreadable: plan.unreadable, alreadyComplete: plan.alreadyComplete.length };
  if (!plan.files.length) return { status: 'nothing-to-do', ...summary };

  const scope = validateWriteScope(site, plan.files);
  if (!scope.ok) return { status: 'blocked', reason: scope.reason, error: scope.error, ...summary };
  const render = await validateRenderingBatch(site, plan.files);
  if (!render.ok) return { status: 'blocked', reason: render.reason, error: render.error, ...summary };

  if (!open) return { status: 'dry-run', files: plan.files.map((f) => f.path), ...summary };

  let branchExists = true;
  try { await getBranchSha(site, branch); } catch (err) { if (/404|Not Found/i.test(err.message)) branchExists = false; else throw err; }
  if (branchExists) return { status: 'branch-exists', error: `${branch} already exists without an open pull request. Delete it on GitHub or open the pull request from it by hand.`, ...summary };
  await createBranch(site, branch, await getBranchSha(site, ref));
  await commitFiles(site, branch, plan.files, 'Action Center: add agent markers (no content changes)');
  const pr = await openPr(site, {
    branch,
    title: 'Action Center: add agent markers',
    body: 'Adds the markers the Action Center writes into (titles, FAQs, schema, internal links and similar). **No content changes.**\n\n'
      + `Files changed: ${plan.files.length}. Review the diff and merge. Once merged, the next scheduled run starts applying fixes.\n\n`
      + (plan.unresolved.length ? `${plan.unresolved.length} marker(s) could not be placed safely and were left out; they are listed in the Action Center.\n` : ''),
  });
  return { status: 'pr-opened', prNumber: pr.number, prUrl: pr.url, files: plan.files.map((f) => f.path), ...summary };
}
