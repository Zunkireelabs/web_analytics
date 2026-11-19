import { hasMarker } from './marker-merge.js';
import { resolveFile, resolveActionFile, resolveMarkers, resolveAdapter, resolveLineKeys } from './url-file-map.js';
import { adoptHeadTags, sameTagsIgnoringOrder } from './head-tag-adopt.js';
import { resolveInsertion } from './insertion-engine.js';
import * as github from '../../github/client.js';

// THE SETUP PR. One pull request, opened once per project after setup, that adds the (empty) SEOAI marker regions to the
// project's real templates, at the places the platform has learned are right for that site's stack. Nothing else changes in
// any file. The next daily run then finds its markers already in place instead of discovering them inside its first real fix.
//
// This reverses an earlier decision. insertion-engine.js was written on a "no second PR" design: markers are created inside the
// same diff as the first real change. Setup PRs are wanted anyway (owner, 2026-11-19) so that the first real PR contains only real
// changes and a placement problem is found and reviewed on its own, one hour after setup, not on the first working day. It does not
// make an undetectable page detectable: those are listed in the PR description for the team, never guessed at.
//
// planSetupPr() decides what would change and touches nothing. openSetupPr() pushes it, and only when it is not a dry run.
// Never merged by the platform: merging is always a human, on GitHub.

export const SETUP_BRANCH_PREFIX = 'seoai/setup-markers';
export const MAX_FILES = 150;    // still a reviewable PR (every change is a comment); anything beyond is left for the first real PRs, which self-heal as before
// Action types that are installed ONCE, sitewide, into the shared layout (backend.js computeMarkerMerge routes analytics-install to
// siteRoot.layoutTemplate, not to the page). They are never asked of each page: doing so (the first version did) made every page look
// partly ready because a per-page file has no <head> for a sitewide script.
export const SITEWIDE_TYPES = ['analytics-install'];
const PAGE_LIMIT = 5000; // every page, not a sample: the point is a pathway for ALL pages. Pages share templates, so files stay few

// Every marker spelling the platform writes: HTML block comments, JSX block comments, and the trailing line comment used for
// front-matter fields (`title: "x" # SEOAI:TITLE`).
const MARKER_TOKEN = /<!--\s*SEOAI:[\w-]+:(?:START|END)\s*-->|\{\/\*\s*SEOAI:[\w-]+:(?:START|END)\s*\*\/\}|[ \t]#[ \t]*SEOAI:[\w-]+/gi;
// An attribute marker (Astro: `title={/* SEOAI:TITLE */ "x"}`) is first turned back into the plain attribute it wraps (`title="x"`), so removing the marker gives
// the original file again; then the marker comments are stripped as before.
const ATTR_MARKER = /=\{\s*\/\*\s*SEOAI:[\w-]+\s*\*\/\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\}/g;
const strip = (s) => String(s ?? '').replace(ATTR_MARKER, '=$1').replace(MARKER_TOKEN, '').replace(/\s+/g, '');

// The safety rule of this whole feature: after removing every marker token, the new file must equal the old file (ignoring the
// whitespace the markers sit on). A change that is anything more than markers is never shipped.
export function onlyMarkersAdded(before, after) {
  return strip(before) === strip(after);
}

const DEFAULT_DEPS = {
  async listPages(site) {
    const { listPageInventory } = await import('../../store/page-inventory.js');
    const { ownDomains, filterOwnDomainPages } = await import('../../agents/lib/site-domain.js');
    const inv = await listPageInventory(site.id, { limit: PAGE_LIMIT }).catch(() => []);
    const urls = inv.map((r) => String(r.page || '')).filter(Boolean);
    if (urls.length) return urls;
    // A brand-new project may have no inventory yet; fall back to what Search Console shows for it.
    const { getSearchPerformanceRange } = await import('../../store/read.js');
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const rows = await getSearchPerformanceRange(site.id, start, end, 'page', PAGE_LIMIT).catch(() => []);
    return filterOwnDomainPages(rows, ownDomains(site)).map((r) => r.dim_value);
  },
  async markerTypes() {
    return (await import('../backend.js')).MARKER_MERGE_TYPES;
  },
  async readFile(site, path, ref) {
    const f = await github.getFileContent(site, path, ref);
    return f ? f.content : null;
  },
  resolveFile, resolveActionFile, resolveMarkers, resolveAdapter, resolveLineKeys, resolveInsertion,
  layoutFile: (site) => site?.url_file_map?.siteRoot?.layoutTemplate || null,
  baseRef: (site) => github.defaultBranchName(site),
};

// What the setup PR would change. Pure with respect to the repo: reads files, writes nothing.
//
// Returns { files: [{ path, content, before, added: [markerName] }], alreadyComplete, unresolved: [{ path, markerName, reason }],
//           skipped: [{ path, reason }], pagesSeen, filesSeen, truncated }
export async function planSetupPr(site, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const pages = await d.listPages(site);
  const types = await d.markerTypes();
  const ref = d.baseRef(site);

  // One entry per template FILE, even when many pages share it (a single [slug] template), with every marker field it needs.
  const byFile = new Map(); // path -> { markerMap: { field: name } }
  const pageNeeds = []; // { page, needs: Map(path -> [markerName]) } for every page that has a file
  const unmappedPages = [];
  // Sitewide markers go to the shared layout, once, and only when the project has one mapped.
  const layoutPath = d.layoutFile(site);
  const sitewideMap = {};
  for (const t of SITEWIDE_TYPES) {
    if (![...types].includes(t)) continue;
    Object.assign(sitewideMap, d.resolveMarkers(site, pages[0] || '', t) || {});
  }
  if (layoutPath && Object.keys(sitewideMap).length) byFile.set(layoutPath, { markerMap: { ...sitewideMap } });

  for (const page of pages) {
    const pageFile = d.resolveFile(site, page);
    const needs = new Map();
    let adapterRouted = false;
    for (const actionType of types) {
      if (SITEWIDE_TYPES.includes(actionType)) continue; // installed once in the layout, never asked of a page
      if (d.resolveAdapter(site, page, actionType)) { adapterRouted = true; continue; } // adapter-routed pages own their own data path, not a marker gap
      const markers = d.resolveMarkers(site, page, actionType);
      // The file THIS action type is written to: the page's own file unless the mapping names another (a per-page head include for
      // open-graph and canonical). The same lookup the daily run's apply uses, so a marker is placed where the fix will look for it.
      const path = pageFile ? d.resolveActionFile(site, page, actionType) : null;
      if (!markers || !path) continue;
      const entry = byFile.get(path) || { markerMap: {}, lineKeys: {} };
      Object.assign(entry.markerMap, markers);
      Object.assign(entry.lineKeys, d.resolveLineKeys(site, page, actionType) || {});
      byFile.set(path, entry);
      needs.set(path, [...(needs.get(path) || []), ...Object.values(markers)]);
    }
    if (pageFile) pageNeeds.push({ page, needs });
    else if (!adapterRouted) unmappedPages.push(page);
  }

  const plan = { files: [], alreadyComplete: 0, unresolved: [], skipped: [], pagesSeen: pages.length, filesSeen: byFile.size, truncated: false,
    sitewide: { layout: layoutPath, markers: Object.values(sitewideMap), layoutMissing: !layoutPath && Object.keys(sitewideMap).length > 0 } };
  const finalContent = new Map(); // path -> the file as it will be after this PR (or as it is, when untouched); absent = unreadable

  for (const [path, { markerMap, lineKeys }] of byFile) {
    let before;
    try { before = await d.readFile(site, path, ref); } catch { plan.skipped.push({ path, reason: 'could not be read' }); continue; }
    if (before == null) { plan.skipped.push({ path, reason: 'not found in the repository' }); continue; }

    finalContent.set(path, before);
    if (Object.values(markerMap).every((name) => hasMarker(before, name))) { plan.alreadyComplete++; continue; }

    // One marker at a time, each checked on its own: the engine creates some markers by adding a NEW front-matter value
    // (a canonical on a markdown page becomes `canonicalUrl: ""`), which is a real content change. That marker is dropped and
    // reported; the others in the same file are still added. The first real fix PR creates it with its real value as before.
    let content = before;
    const added = [];
    let moved = false; // a file whose existing head tags were moved into a marker: later steps are checked line-for-line, not byte-for-byte
    for (const [field, markerName] of Object.entries(markerMap)) {
      if (hasMarker(content, markerName)) continue;
      // Head tags that already exist (a converted site hard-codes og:/twitter:/canonical in its head file) are ADOPTED into the marker, so
      // the first fix replaces them. A marker added beside them would give two sets of tags. Checked: same lines, nothing lost or added.
      const adopt = (field === 'canonical' || field === 'openGraph') ? adoptHeadTags(content, field, markerName, path) : { ok: false };
      if (adopt.ok) {
        if (sameTagsIgnoringOrder(before, adopt.content)) { content = adopt.content; added.push(markerName); moved = true; continue; }
        plan.skipped.push({ path, markerName, reason: 'moving its existing tags into the marker would have changed more than their position, so it was left alone' });
        continue;
      }
      const { content: next, unresolved } = await d.resolveInsertion(site, content, path, { [field]: markerName }, { lineKeys });
      for (const u of unresolved) plan.unresolved.push({ path, markerName: u.markerName, reason: u.reason });
      if (!hasMarker(next, markerName)) continue;
      if (!(moved ? sameTagsIgnoringOrder(before, next) : onlyMarkersAdded(before, next))) { plan.skipped.push({ path, markerName, reason: 'creating it would add a value, not only a marker, so it is left for the first real fix' }); continue; }
      content = next;
      added.push(markerName);
    }
    if (!added.length) continue;
    if (plan.files.length >= MAX_FILES) { plan.truncated = true; continue; }
    plan.files.push({ path, content, before, added });
    finalContent.set(path, content);
  }

  // The point of the PR: how many pages the agent can fix from tomorrow. A page is READY when its template file will hold every
  // marker its generators need once this PR is merged; PARTIAL when some are missing (they self-heal inside the first real fix,
  // or are listed under "not added"); UNMAPPED when the platform has no template file for it at all (nothing can be fixed there
  // until that is learned). Counted per page, not per file, because that is what a client thinks in.
  const coverage = { ready: 0, partial: 0, unmapped: unmappedPages.length, unknown: 0, unmappedExamples: unmappedPages.slice(0, 10) };
  for (const { needs } of pageNeeds) {
    let unknown = false; let missing = false;
    for (const [path, names] of needs) {
      const content = finalContent.get(path);
      if (content == null) { unknown = true; continue; }
      if (!names.every((n) => hasMarker(content, n))) missing = true;
    }
    if (unknown) coverage.unknown++; else if (missing) coverage.partial++; else coverage.ready++;
  }
  plan.coverage = coverage;

  // Page by page, marker by marker: what is placed (now or already) and, for each one that is not, WHY. The completeness gate reads this; a count can hide a
  // missing marker, a list of named gaps cannot. A reason comes from what the planner recorded for that file and marker; with none recorded it says so.
  const reasonFor = new Map();
  for (const u of plan.unresolved) reasonFor.set(`${u.path}::${u.markerName}`, u.reason);
  for (const s of plan.skipped) if (s.markerName) reasonFor.set(`${s.path}::${s.markerName}`, s.reason);
  const gaps = []; let placed = 0;
  for (const { page, needs } of pageNeeds) {
    for (const [path, names] of needs) {
      const content = finalContent.get(path);
      for (const name of [...new Set(names)]) {
        if (content != null && hasMarker(content, name)) { placed++; continue; }
        gaps.push({ page, path, marker: name, reason: content == null ? 'file-could-not-be-read' : (reasonFor.get(`${path}::${name}`) || (plan.truncated ? 'left-out-of-this-pr-by-the-file-cap' : 'not-placed')) });
      }
    }
  }
  plan.gaps = gaps;
  plan.placedCount = placed;
  return plan;
}

export function setupBranchName(site, date = new Date()) {
  return `${SETUP_BRANCH_PREFIX}-${site.id}-${date.toISOString().slice(0, 10)}`;
}

export function setupPrBody(site, plan, { stack = null } = {}) {
  const markerCount = plan.files.reduce((n, f) => n + f.added.length, 0);
  const lines = [
    `This is the one-time setup pull request for **${site.name}**. It adds empty SuperRank marker regions to the templates below, at the places the platform worked out for this site${stack ? ` (stack: ${stack})` : ''}.`,
    '',
    '**It changes nothing a visitor can see.** The markers are comments. Nothing else in any file is touched: before each file was included, the platform checked that removing the markers gives back the original file exactly.',
    '',
    `**Why:** so the daily fixes that follow go straight into place, and any placement problem shows up here, in one small reviewable PR, instead of inside the first real fix.`,
    '',
    `**What is added:** ${markerCount} marker${markerCount === 1 ? '' : 's'} in ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}.`,
    '',
    ...(plan.coverage ? [
      `**Pages ready for the daily fixes once this is merged:** ${plan.coverage.ready} of ${plan.pagesSeen}.`,
      ...(plan.coverage.partial ? [`- ${plan.coverage.partial} page${plan.coverage.partial === 1 ? '' : 's'} partly ready: some markers could not be placed safely (listed below). Fixes for those still work, and the missing marker is created inside the first fix that needs it.`] : []),
      ...(plan.coverage.unmapped ? [`- ${plan.coverage.unmapped} page${plan.coverage.unmapped === 1 ? '' : 's'} with no template file known yet, so nothing can be changed there until the platform learns where they live.`] : []),
      '',
    ] : []),
    ...plan.files.map((f) => `- \`${f.path}\`: ${f.added.join(', ')}`),
  ];
  if (plan.truncated) lines.push('', `This PR is capped at ${MAX_FILES} files. The remaining templates get their markers inside the first real fix that needs them.`);
  if (plan.sitewide?.layoutMissing) {
    lines.push('', `**Sitewide analytics markers were not added:** this project has no shared layout file mapped yet, and the analytics script is installed once in the layout, not on each page.`);
  } else if (plan.sitewide?.layout && plan.sitewide.markers.length) {
    lines.push('', `**Sitewide:** analytics markers go in the shared layout, \`${plan.sitewide.layout}\`, once.`);
  }
  if (plan.unresolved.length) {
    // Grouped by what could not be placed and why, with a few example files, so a big site does not produce a wall of lines.
    const groups = new Map();
    for (const u of new Map(plan.unresolved.map((x) => [`${x.path}::${x.markerName}`, x])).values()) {
      const key = `${u.markerName}: ${u.reason}`;
      const g = groups.get(key) || { n: 0, examples: [] };
      g.n++; if (g.examples.length < 3) g.examples.push(u.path);
      groups.set(key, g);
    }
    lines.push('', '**Not added (no safe place was found):**',
      ...[...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([k, g]) => `- ${k} in ${g.n} file${g.n === 1 ? '' : 's'} (e.g. ${g.examples.map((e) => `\`${e}\``).join(', ')})`),
      '', 'These are not guessed at. The platform team will look at them; they need no action from you.');
  }
  lines.push('', 'Review and merge when you are ready. SuperRank never merges it for you.');
  return lines.join('\n');
}

// Pushes the plan as one branch and one pull request. dryRun returns what it would do and writes nothing.
export async function openSetupPr(site, plan, { dryRun = false, stack = null, date = new Date(), gh = github } = {}) {
  if (!plan.files.length) return { ok: true, opened: false, reason: 'nothing-to-add', plan };
  const branch = setupBranchName(site, date);
  if (dryRun) return { ok: true, opened: false, dryRun: true, branch, wouldChange: plan.files.map((f) => ({ path: f.path, added: f.added })), plan };

  const existing = await gh.listOpenPullRequestsForBranch(site, branch);
  if (existing.length) return { ok: true, opened: false, reason: 'already-open', prNumber: existing[0].number, prUrl: existing[0].html_url, branch };

  const sha = await gh.getDefaultBranchSha(site);
  await gh.createBranch(site, branch, sha);
  await gh.commitFilesAtomic(site, branch, plan.files.map((f) => ({ path: f.path, content: f.content })),
    `Setup: add SuperRank markers to ${plan.files.length} template${plan.files.length === 1 ? '' : 's'}`);
  const pr = await gh.openPullRequest(site, {
    branch,
    title: `SuperRank setup: add markers to ${plan.files.length} template${plan.files.length === 1 ? '' : 's'}`,
    body: setupPrBody(site, plan, { stack }),
  });
  return { ok: true, opened: true, branch, prNumber: pr.number, prUrl: pr.url, files: plan.files.length };
}

// The commit subject every setup PR commit carries, so a rebuild can tell its own work from anyone else's.
const OWN_SUBJECT = /^Setup: add SuperRank markers/;

// Rebuilds an EXISTING setup PR in place: the plan is made again from the default branch as it is now (the mapping and the engine may have
// improved since the PR opened), the branch is reset to ONE new commit on the default branch's tip, and the PR keeps its number, its
// reviewers and its comments; only its diff, title and description change. No second PR is opened.
//
// Refuses when anyone else has added a commit to the branch (anything whose subject is not ours): their work would be overwritten.
// dryRun reads and plans and writes nothing.
export async function refreshSetupPr(site, { branch, prNumber, dryRun = false, stack = null, gh = github, plan = null } = {}) {
  if (!branch || !prNumber) return { ok: false, reason: 'missing-branch-or-pr' };
  const subjects = await gh.listCommitSubjectsAheadOfBase(site, branch);
  if (subjects == null) return { ok: false, reason: 'branch-gone' };
  const foreign = subjects.filter((s) => !OWN_SUBJECT.test(s));
  if (foreign.length) return { ok: false, reason: 'branch-has-other-commits', foreign: foreign.slice(0, 3) };

  const next = plan || await planSetupPr(site);
  if (!next.files.length) return { ok: true, refreshed: false, reason: 'nothing-to-add', plan: next };
  const summary = { files: next.files.length, markers: next.files.reduce((n, f) => n + f.added.length, 0), coverage: next.coverage };
  if (dryRun) return { ok: true, refreshed: false, dryRun: true, branch, prNumber, summary, plan: next };

  const baseSha = await gh.getDefaultBranchSha(site);
  const message = `Setup: add SuperRank markers to ${next.files.length} template${next.files.length === 1 ? '' : 's'}`;
  const sha = await gh.createCommitObject(site, baseSha, next.files.map((f) => ({ path: f.path, content: f.content })), message);
  await gh.updateRef(site, branch, sha, { force: true });
  await gh.updatePullRequest(site, prNumber, {
    title: `SuperRank setup: add markers to ${next.files.length} template${next.files.length === 1 ? '' : 's'}`,
    body: setupPrBody(site, next, { stack }),
  });
  return { ok: true, refreshed: true, branch, prNumber, summary, plan: next };
}
