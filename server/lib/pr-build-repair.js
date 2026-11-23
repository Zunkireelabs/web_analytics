import { dedupeFrontMatterKeys, findDuplicateFrontMatterKeys } from '../implementers/lib/marker-merge.js';
import {
  getPullRequest, listPullRequestFiles, getCheckRunsDetailedForRef, getJobLogText, getFileContent, commitFilesAtomic, listCommitSubjectsAheadOfBase,
} from '../github/client.js';

// BUILD REPAIR: when the build of a PR the agent opened fails, read WHY, fix it on that same PR, and hold back what cannot be fixed.
//
// WHY THIS EXISTS. The platform never runs a client's build. It writes files, runs its own structural checks, opens the PR and leaves the real build to the
// client's CI, and nothing read the result. superrank-web PR 15 sat as "ready to merge" with a red build ("duplicated mapping key", then a second failure behind
// it: a new post the content schema rejected) until a person opened the log. This closes that loop for the PRs the agent owns.
//
// WHAT IT DOES. For one open PR on an agent branch (action-center/batch-*) whose check failed:
//   1. read the failing job's log and classify the failure (classifyBuildFailure): which kind, and which of the PR's OWN files it names;
//   2. plan the smallest safe change (planRepair):
//        duplicated front-matter key  -> repair that file (dedupeFrontMatterKeys, deterministic);
//        anything else naming a file the PR changed -> take that file back to what the base branch has (a new file is removed), so the PR stops carrying
//          the change that breaks the build; the change is reported, not lost;
//   3. apply it as ONE new commit on the PR's branch (fast-forward, never a force-push), and let CI run again.
// A failure that names no file the PR changed is not this PR's doing (the base was already red): nothing is touched and it is reported.
//
// GUARDS. Agent branches only. Open, unmerged PRs only. Only files the PR changed. Never merges. At most MAX_REPAIR_COMMITS repair commits per PR, counted from the
// branch's own commit subjects, so a repair that does not turn the build green cannot loop. `apply: false` (the default) plans and writes nothing.
//
// FORMATS. The log patterns below were taken from real failing runs (Astro/js-yaml, Astro content collections). The Next.js and Eleventy patterns follow those
// tools' documented output and have NOT been checked against a real failing run: needs-verification. An unrecognised log is "unknown", and unknown changes nothing.

export const AGENT_BRANCH_PREFIX = 'action-center/batch-';
export const MAX_REPAIR_COMMITS = 2;
export const REPAIR_SUBJECT_PREFIX = 'Build repair:';

const ANSI = /\u001b\[[0-9;]*m|\^\[\[[0-9;]*m/g;
const ACTIONS_TS = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
const SRC_EXT = '(?:tsx?|jsx?|mjs|cjs|mdx?|json|njk|liquid|html?|astro|vue|svelte|ya?ml|css|scss)';

// A log as plain lines: no colour codes, no "2026-11-23T06:20:47.8Z " prefixes, no "Build\tBuild\t" job/step columns.
export function cleanLog(text) {
  return String(text || '').split('\n').map((l) => l.replace(/^[^\t\n]*\t[^\t\n]*\t/, '').replace(ANSI, '').replace(ACTIONS_TS, '').replace(/\r$/, '')).join('\n');
}

// A path as it appears in a log, made relative to the repository: "/home/runner/work/repo/repo/src/a.md:5:0" -> "src/a.md"; "./src/a.tsx" -> "src/a.tsx".
export function repoRelative(p, repoName = '') {
  let s = String(p || '').trim().replace(/[:,)]+\d*(?::\d+)?$/, '').replace(/^\.\//, '');
  const work = /\/work\/([^/]+)\/\1\/(.+)$/.exec(s) || (repoName ? new RegExp(`/${repoName}/(.+)$`).exec(s) : null);
  if (work) s = work[work.length - 1];
  return s.replace(/^\/+/, '');
}

const PATH_IN_LOG = new RegExp(`(?:\\.{0,2}/|/)?(?:[A-Za-z0-9_@.\\[\\]()-]+/)+[A-Za-z0-9_@.\\[\\]()-]+\\.${SRC_EXT}(?::\\d+(?::\\d+)?)?`, 'g');

/**
 * @param {string} logText raw job log
 * @param {string[]} changedFiles the PR's own files (repo-relative)
 * @returns {{ kind: string, files: string[], mentioned: string[], excerpt: string }}
 *   kind: duplicate-front-matter-key | content-schema | compile-error | template-error | unknown
 *   files: the PR's own files the log names (the only ones a repair may touch); mentioned: every source path the log names
 */
export function classifyBuildFailure(logText, changedFiles = [], { repoName = '' } = {}) {
  const log = cleanLog(logText);
  const lines = log.split('\n');
  const changed = new Set(changedFiles);

  const mentioned = [];
  for (const m of log.matchAll(PATH_IN_LOG)) {
    const rel = repoRelative(m[0], repoName);
    if (rel && !rel.startsWith('node_modules/') && !mentioned.includes(rel)) mentioned.push(rel);
  }
  const ours = mentioned.filter((p) => changed.has(p));

  let kind = 'unknown';
  if (/duplicated mapping key|duplicate (?:mapping )?key|YAMLException[^\n]*duplicat/i.test(log)) kind = 'duplicate-front-matter-key';
  else if (/InvalidContentEntryDataError|does not match collection schema/i.test(log)) kind = 'content-schema';
  else if (/Failed to compile|Type error:|Module not found|Error occurred prerendering page|SyntaxError|Unexpected token|ReferenceError|TypeError/.test(log)) kind = 'compile-error';
  else if (/Having trouble (?:rendering|compiling)|Template render error|TemplateContentRenderError|\(\.\/[^)]+\)/.test(log)) kind = 'template-error';

  // The few lines around the first error, for a person reading the report.
  const at = lines.findIndex((l) => /error|failed|duplicated|invalid/i.test(l));
  const excerpt = (at >= 0 ? lines.slice(Math.max(0, at - 1), at + 8) : lines.slice(-8)).join('\n').trim().slice(0, 900);
  return { kind, files: ours, mentioned, excerpt };
}

/**
 * Decide what to do. `files` = [{ path, status, headContent, baseContent }] for the files in `failure.files` (status as GitHub reports it for the PR).
 * @returns {{ status: 'repair'|'hold'|'not-ours'|'unknown', actions: Array<{path, op:'rewrite'|'revert'|'delete', content?, why}> }}
 */
export function planRepair(failure, files = []) {
  if (!failure.files.length) {
    // The log names nothing this PR changed: the build was already red without it, or the log is not one this module reads.
    return { status: failure.kind === 'unknown' && !failure.mentioned.length ? 'unknown' : 'not-ours', actions: [] };
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const actions = [];
  for (const path of failure.files) {
    const f = byPath.get(path);
    if (!f) continue;
    if (failure.kind === 'duplicate-front-matter-key' && f.headContent != null) {
      const fixed = dedupeFrontMatterKeys(f.headContent, path);
      if (fixed !== f.headContent && !findDuplicateFrontMatterKeys(fixed, path).length) {
        actions.push({ path, op: 'rewrite', content: fixed, why: 'the front matter named a key twice; the later copy was removed and the first kept' });
        continue;
      }
    }
    // Anything else: stop this PR from carrying the change that breaks the build.
    if (f.status === 'added') actions.push({ path, op: 'delete', why: 'this new file fails the site build and cannot be repaired automatically, so it was taken out of the PR' });
    else if (f.baseContent != null) actions.push({ path, op: 'revert', content: f.baseContent, why: 'this change fails the site build and cannot be repaired automatically, so the file was put back to what the base branch has' });
  }
  return { status: actions.length ? (actions.every((a) => a.op === 'rewrite') ? 'repair' : 'hold') : 'unknown', actions };
}

const DEFAULT_DEPS = {
  getPullRequest, listPullRequestFiles, getCheckRunsDetailedForRef, getJobLogText, getFileContent, commitFilesAtomic, listCommitSubjectsAheadOfBase,
};

/**
 * Read one PR's failing build, plan the repair and (only when `apply`) push it as one commit.
 * @returns {Promise<{ outcome: string, prNumber, failure?, plan?, commit?, reason? }>}
 *   outcome: skipped | green | pending | repaired | held | not-ours | unknown | gave-up | planned
 */
export async function repairFailingBatchPr(site, prNumber, { apply = false, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const pr = await d.getPullRequest(site, prNumber);
  if (!pr || pr.state !== 'open' || pr.merged) return { outcome: 'skipped', prNumber, reason: 'The pull request is not open.' };
  if (!pr.headRef || !pr.headRef.startsWith(AGENT_BRANCH_PREFIX)) return { outcome: 'skipped', prNumber, reason: `Only branches the agent owns (${AGENT_BRANCH_PREFIX}*) are repaired; this one is "${pr.headRef}".` };

  const runs = await d.getCheckRunsDetailedForRef(site, pr.headSha);
  if (runs.some((r) => r.status !== 'completed')) return { outcome: 'pending', prNumber, reason: 'A check is still running.' };
  const failed = runs.filter((r) => ['failure', 'timed_out'].includes(r.conclusion));
  if (!failed.length) return { outcome: 'green', prNumber, reason: runs.length ? 'No check failed.' : 'No check ran on this PR.' };

  const subjects = (await d.listCommitSubjectsAheadOfBase(site, pr.headRef, { base: pr.base }).catch(() => [])) || [];
  const done = subjects.filter((s) => s.startsWith(REPAIR_SUBJECT_PREFIX)).length;
  if (done >= MAX_REPAIR_COMMITS) return { outcome: 'gave-up', prNumber, reason: `${done} repair commits are already on this branch and the build is still red; a person needs to look.` };

  const prFiles = await d.listPullRequestFiles(site, prNumber);
  const changed = prFiles.filter((f) => f.status !== 'removed').map((f) => f.path);

  // The first failing job that names one of this PR's files decides; the rest are noted.
  let failure = null; let plan = null;
  for (const run of failed) {
    const log = await d.getJobLogText(site, run.id);
    const c = classifyBuildFailure(log, changed, { repoName: site.repo_name });
    const withContent = [];
    for (const path of c.files) {
      const status = prFiles.find((f) => f.path === path)?.status || 'modified';
      const head = await d.getFileContent(site, path, pr.headRef).catch(() => null);
      const base = status === 'added' ? null : await d.getFileContent(site, path, pr.base).catch(() => null);
      withContent.push({ path, status, headContent: head?.content ?? null, baseContent: base?.content ?? null });
    }
    const p = planRepair(c, withContent);
    if (!failure || p.actions.length) { failure = { ...c, check: run.name, url: run.url }; plan = p; }
    if (p.actions.length) break;
  }

  if (!plan.actions.length) return { outcome: plan.status === 'not-ours' ? 'not-ours' : 'unknown', prNumber, failure, plan, reason: plan.status === 'not-ours' ? 'The failing build names no file this PR changed, so it was red before this PR; nothing was touched.' : 'The failure was not recognised, so nothing was touched.' };
  if (!apply) return { outcome: 'planned', prNumber, failure, plan };

  const files = plan.actions.map((a) => (a.op === 'delete' ? { path: a.path, delete: true } : { path: a.path, content: a.content }));
  const message = `${REPAIR_SUBJECT_PREFIX} ${plan.actions.map((a) => `${a.op} ${a.path}`).join(', ').slice(0, 160)}\n\nThe site build failed on this PR (${failure.check}: ${failure.kind}).\n${plan.actions.map((a) => `- ${a.path}: ${a.why}`).join('\n')}`;
  const { sha } = await d.commitFilesAtomic(site, pr.headRef, files, message);
  return { outcome: plan.status === 'repair' ? 'repaired' : 'held', prNumber, failure, plan, commit: sha };
}
