import {
  getBranchSha, createBranch, commitFilesAtomic, createCommitObject, updateRef,
  openPullRequest, listOpenPullRequestsForBranch, defaultBranchName, mergeBranchFromBase, getFileContent,
  beginFileOverlay, endFileOverlay, recordFileOverlayWrites, compareCommits,
} from '../../github/client.js';
import { safeMessage } from '../../lib/errors.js';
import { todayInTz } from '../../util/dates.js';
import { validateRenderingBatch } from './rendering-gate.js';
import { actionScopeFor } from './action-scope.js';
import { findMarkerCorruption } from './marker-merge.js';

// Every draft branch forks from — and every "current content" read (diff
// preview, live-view, existence check) diffs against — the site's own
// default branch (site.repo_default_branch, 'main' if unset). This is
// deliberately the SAME branch openPrForBranch below opens the PR into, so
// a batch PR's diff only ever contains this batch's actual changes — no
// separate staging branch to drift out of sync with production and leak
// unrelated changes into every PR. Exported so backend.js/frontend.js read
// the SAME branch when fetching "current" content for a diff (preview) as
// pushDraftBranch actually forks from.
export function baseBranch(site) {
  return defaultBranchName(site);
}

// Deterministic per-site, per-calendar-day branch name. Strict day-boundary-
// keyed by design — NOT "reuse until merged": a new branch starts every day
// regardless of whether yesterday's branch/PR was ever merged, which can
// leave a prior day's branch/PR open and orphaned forever if nobody merges
// it — that's accepted, not a bug (see openPrForBranch's PR body, which
// surfaces this to the human reviewer). UTC date, so behavior is identical
// regardless of server locale/deploy region.
// Every failure below is PERSISTED — pushDraftBranch's message lands in
// drafts.apply_error, the two PR openers' in drafts.merge_error — and is then
// read by a human days later trying to work out why a draft is stuck. The
// sanitized text alone cannot answer that: safeMessage deliberately replaces the
// real error (which may carry tokens, hostnames or status codes) with fixed
// customer-safe wording, and the only copy of the real cause is a server log
// line keyed by the id it returns. Dropping that id, as these three call sites
// did, made a stuck draft undiagnosable from the database.
//
// Real case: site 1 had four drafts sitting 'approved' with branch_name NULL for
// three days, all reading "This change could not be pushed to a branch right
// now", with nothing to correlate against the logs.
//
// The id is an opaque correlation key, not sensitive — worker.js's job logs
// already surface it the same way ("Job failed: … (ref: …)"). This keeps the two
// consistent.
// `rateLimited` is carried through deliberately, and is the ONE piece of the
// original error that survives sanitization here. It has to: safeMessage
// replaces the provider's text with a generic customer-safe string plus a
// ref id, which is correct for display but erases the only evidence that a
// failure was transient. Without this flag the caller cannot tell
// "GitHub's budget refills in 40 minutes" from "this token can't write to
// this repo" — and on 2026-09-01 that missing distinction abandoned 54
// drafts in one call. A boolean leaks nothing: it says a rate limit
// occurred, never who, where, or with what credential.
function persistedFailure(context, err, fallback) {
  const { message, id } = safeMessage(context, err, fallback);
  return { ok: false, reason: 'github-error', error: `${message} (ref: ${id})`, rateLimited: err?.rateLimited === true };
}

// One batch branch per site per DAY — and "day" here must be the same day the
// daily budget counts in, which is the site's own timezone (store/drafts.js's
// countDraftsBySourceToday, isShipCatchupOwed). This used to slice a UTC
// ISO string, so for any site east of UTC the two disagreed for part of every
// day: an Asia/Kolkata site shipping at 07:00 local (01:30 UTC) opened
// `batch-<id>-<utc-today>`, and its own catch-up guard a few hours later —
// still the same local day, still the same budget day — computed a DIFFERENT
// UTC date and opened a SECOND branch and a second PR for work that belongs
// in the day's single reviewable batch.
//
// Still idempotent: same site + same local day always produces the same name,
// which is what lets beginBatchPush reuse an existing branch rather than
// forking a new one.
export function batchBranchName(site, date = new Date()) {
  const day = todayInTz(site.timezone || 'UTC', date);
  return `action-center/batch-${site.id}-${day}`;
}

// Detects whether today's batch branch already has commits (i.e. this is
// NOT the first draft pushed today) vs. needs to be created fresh from the
// site's default branch. GitHub's 404 body for a missing ref is the standard
// `{"message":"Not Found",...}` shape — same body-sniffing convention
// createBranch below already uses for its 422 case.
//
// A branch that already exists is also re-synced with the site's default
// branch here, every call — without this, only the FIRST draft pushed on a
// given day forks from main's live tip; every later draft that same day
// would splice against whatever the batch branch already had that morning,
// silently drifting further from main as the day goes on and any other work
// (this app's own other merged PRs, or a human pushing directly) lands on
// main in between. GitHub's own merge-conflict check was the only thing that
// ever caught that drift before, and only at PR-review time — days later, in
// one real incident. `conflicted: true` means the sync itself hit a real
// merge conflict (base and the batch branch both touched the same lines) —
// callers must fail fast on this rather than splice against stale content.
export async function getOrInitBatchBranch(site, date = new Date()) {
  const branchName = batchBranchName(site, date);
  let beforeSha;
  try {
    beforeSha = await getBranchSha(site, branchName);
  } catch (err) {
    if (/404|Not Found/i.test(err.message)) return { branchName, exists: false, conflicted: false };
    throw err;
  }

  const synced = await mergeBranchFromBase(site, branchName, baseBranch(site));
  if (!synced.ok) return { branchName, exists: true, conflicted: true };
  if (!synced.synced) return { branchName, exists: true, conflicted: false };

  // A 201 here only means git's own line-based merge found no OVERLAPPING
  // hunk — it does NOT mean the result is semantically valid. See
  // findMarkerCorruption's module comment (marker-merge.js) for the real
  // incident (zunkireelabs-web PR #87) this guards against: two drafts
  // independently replacing the same marker's line, one on each side of the
  // merge, can "cleanly" merge into a duplicated line that's invalid content
  // git never notices. Checked here, right after the sync, so a corrupted
  // batch branch is caught before more drafts stack on top of it — not
  // three checks and a human reviewer later, as it was on PR #87.
  const corruptedFiles = await findSyncCorruption(site, branchName, beforeSha, synced.sha);
  if (corruptedFiles.length) return { branchName, exists: true, conflicted: true, corrupted: true, corruptedFiles };

  return { branchName, exists: true, conflicted: false };
}

// Scans only the files the sync itself touched (via compareCommits) rather
// than the whole repo — a same-day batch branch only ever has a handful of
// files in play. Best-effort: a failure IN the check (compareCommits/
// getFileContent erroring) must never block a sync that git itself already
// reported as clean, so it degrades to "no corruption found" rather than
// throwing — same conservatism as every other honest-vs-silent tradeoff in
// this file, just inverted, since blocking a healthy sync on this check's
// own plumbing would be a worse outcome than occasionally missing a real
// corruption.
async function findSyncCorruption(site, branchName, beforeSha, afterSha) {
  if (!afterSha || beforeSha === afterSha) return [];
  let changed;
  try {
    changed = await compareCommits(site, beforeSha, afterSha);
  } catch {
    return [];
  }

  const corruptedFiles = [];
  for (const path of changed.files) {
    const file = await getFileContent(site, path, branchName).catch(() => null);
    if (!file) continue;
    const markers = findMarkerCorruption(file.content);
    if (markers.length) corruptedFiles.push({ path, markers });
  }
  return corruptedFiles;
}

// Shared, consistent failure shape for every apply()/preview() call site
// that checks `batchInfo.conflicted` right after getOrInitBatchBranch —
// same {ok, reason, error} contract as every other honest-failure return in
// this app (e.g. render-mode-uncertain), so it flows through recordApply-
// Failure/sendHttpError exactly like any other apply() failure.
export function batchBranchConflictError(site, batchInfo) {
  if (batchInfo.corrupted) {
    const files = batchInfo.corruptedFiles.map(({ path, markers }) => `${path} (${markers.join(', ')})`).join('; ');
    return {
      ok: false, reason: 'batch-branch-conflicted',
      error: `Today's batch branch (${batchInfo.branchName}) synced with ${baseBranch(site)} without a reported git conflict, but left a duplicated marker in: ${files} — likely two drafts independently editing the same field, one on each side of the sync. Resolve it manually on GitHub before more drafts can be pushed today.`,
    };
  }
  return {
    ok: false, reason: 'batch-branch-conflicted',
    error: `Today's batch branch (${batchInfo.branchName}) has diverged from ${baseBranch(site)} and couldn't be auto-synced — resolve the conflict manually on GitHub before more drafts can be pushed today.`,
  };
}

// Must match FAMILY_WRITE_MARKER in the site repo's own
// check-family-siblings.mjs (installed verbatim by install-rendering-
// workflow.js) exactly. That gate greps `git log` on the PR's commit range
// for this literal string; it has no way to ask this app *why* a commit
// touched a shared `_data/*` file, only whether the marker is present
// somewhere in the range.
const FAMILY_WRITE_MARKER = '[family-write]';

// True when this draft's commit would be the SECOND (or later) write today
// to a `_data/*` array file already changed earlier on today's batch branch.
// Each Action Center draft splices exactly one record into its data file
// (see adapters/lib/js-data-splice.js), so a single draft's own files never
// trip the site's per-family "1 changed sibling" cap by themselves — the
// leak only happens when several same-day drafts against DIFFERENT records
// of the SAME shared data file get batched onto one branch/PR (see
// getOrInitBatchBranch's "additional drafts... added as new commits to this
// same branch" comment). That's a legitimate, human-reviewable outcome, not
// a bug — so it's declared via FAMILY_WRITE_MARKER rather than blocked.
//
// Detected generically, with no hardcoded family/route knowledge (this app
// doesn't parse the site's Eleventy front matter): a `_data/*` file this
// draft is about to write already differing between today's batch branch's
// current tip and the site's base branch means an earlier commit THIS PR
// already touched it — the exact case the sibling-leakage gate flags.
//
// A `GLOBAL_BY_DESIGN` draft (action-scope.js — analytics-install,
// security-headers, html-lang, ...) is a second, unconditional case: its one
// real target IS the site's shared layout template, so a SINGLE such write
// already changes every family's rendered output by itself — there's no
// "second write collides with an earlier one" to detect, unlike a `_data/*`
// splice. Confirmed live on site 1's 2026-09-08 batch: two analytics-install
// drafts wrote src/_includes/layouts/base.njk (no `_data/*` file touched at
// all), and check-family-siblings.mjs — which diffs each family's RENDERED
// dist output, not this app's source diff — correctly flagged all 21
// glossary + 4 compare + 4 locations pages as changed, with no commit
// carrying the marker to say so was intentional.
async function needsFamilyWriteMarker(site, draft, files, target) {
  if (actionScopeFor(draft.action_type) === 'global-by-design') return true;
  if (!target.exists) return false; // first commit on today's branch — nothing prior to collide with
  const dataFiles = files.filter((f) => /(^|\/)_data\//.test(f.path));
  if (!dataFiles.length) return false;

  const base = baseBranch(site);
  for (const f of dataFiles) {
    const [baseFile, headFile] = await Promise.all([
      getFileContent(site, f.path, base),
      getFileContent(site, f.path, target.branchName),
    ]);
    if ((baseFile?.content ?? null) !== (headFile?.content ?? null)) return true;
  }
  return false;
}

// Deferred-push registry (Action Center same-day batching) — see
// beginBatchPush/endBatchPush below. Keyed by branch name (already
// per-site-per-day unique, see batchBranchName). While a branch has an
// entry here, pushDraftBranch chains its commit onto `headSha` instead of
// moving the branch ref immediately; endBatchPush moves it once, for
// everything queued since beginBatchPush.
const activeBatches = new Map(); // branchName -> { headSha: string|null, count: number }

// Call once before looping through a batch run (routes/action-center.js's
// executeSafeFixes, auto-remediation.js's per-run loop) so every
// pushDraftBranch call for this branch during the run creates its commit
// WITHOUT moving the branch ref — GitHub (and therefore Vercel's per-push
// preview build) only sees the branch move once, at endBatchPush, instead
// of once per successfully shipped recommendation. A run that ships up to
// 60 items used to trigger up to 60 separate preview builds on the SAME
// PR; this collapses that to one. Also opens the matching file-read overlay
// (github/client.js) so a later item in the same run sees an earlier item's
// write immediately, instead of the stale pre-batch content the real
// (not-yet-moved) branch ref would otherwise return.
//
// Idempotent: a re-entrant call for a branch already batching is a no-op,
// so a nested/accidental double-call can't clobber an in-progress chain.
export function beginBatchPush(site, branchName) {
  if (!activeBatches.has(branchName)) {
    activeBatches.set(branchName, { headSha: null, count: 0 });
    beginFileOverlay(site, branchName);
  }
}

// Pushes every commit accumulated since beginBatchPush as ONE ref update —
// the one real "push" for the whole run — and always clears the batch
// state (ref-chain AND file overlay) afterward, even on failure, so a
// failed run doesn't leave pushDraftBranch silently deferring forever.
// Returns { ok: true, pushed: 0 } when there was nothing to push (e.g.
// every item in the run failed before it could commit).
export async function endBatchPush(site, branchName) {
  const state = activeBatches.get(branchName);
  activeBatches.delete(branchName);
  endFileOverlay(site, branchName);
  if (!state || state.headSha == null) return { ok: true, pushed: 0 };
  try {
    await updateRef(site, branchName, state.headSha);
    return { ok: true, pushed: state.count };
  } catch (err) {
    return persistedFailure('github-ops.endBatchPush', err, 'This batch of changes could not be pushed to GitHub right now — our team has been notified.');
  }
}

// Two real, independently-triggered steps — deliberately NOT bundled. Staff
// needs a real manual checkpoint between "a branch with the real change
// exists" and "a PR is open for someone to review and merge," so they
// can review the real pushed diff (dashboard's Draft Preview panel) first.
//
// `target` ({ branchName, exists }) is required and always passed explicitly
// by the caller — either today's shared batch branch (via
// getOrInitBatchBranch, the normal case for every implementer's apply()) or
// an isolated one-off branch (the rollback path, see
// adapters/lib/data-file-writer.js's rollbackFromSnapshot). Branch identity
// is no longer derived from draft.action_type/draft.id here, since it's no
// longer 1:1 with a single draft — every caller must decide.
export async function pushDraftBranch(site, draft, files, target) {
  // Generic pre-PR Rendering Validation Gate (see lib/rendering-gate.js) —
  // checked before anything is written, so a batch never partially lands on
  // the shared branch. Every implementer funnels through this one function,
  // so this is the single place a future generator/implementer inherits the
  // gate automatically, with no per-generator code.
  const renderGate = await validateRenderingBatch(site, files);
  if (!renderGate.ok) return renderGate;

  const { branchName, exists } = target;
  try {
    let freshBranchSha = null;
    if (!exists) {
      freshBranchSha = await getBranchSha(site, baseBranch(site));
      await createBranch(site, branchName, freshBranchSha);
    }

    // One atomic commit for all of this draft's files (Git Data API:
    // tree -> commit -> ref update) — either every file lands together or
    // the branch never moves, so a mid-write failure can never leave an
    // earlier file's change stranded on the shared batch branch owned by no
    // draft (see commitFilesAtomic's comment). Replaces a previous
    // sequential getFileSha+putFile-per-file loop, which had exactly that
    // gap for multi-file draft types (llms-txt+robots.txt, broken-link-fix).
    const marker = (await needsFamilyWriteMarker(site, draft, files, target)) ? ` ${FAMILY_WRITE_MARKER}` : '';
    const message = `Action Center: apply ${draft.action_type} draft #${draft.id}${marker}`;

    const batch = activeBatches.get(branchName);
    if (batch) {
      // Deferred mode: chain this commit off the last one queued so far
      // this run (or the branch's real current tip/just-created sha, for
      // the first commit of the run) — but don't move the ref. endBatchPush
      // does that once, for the whole run.
      if (batch.headSha == null) batch.headSha = freshBranchSha ?? await getBranchSha(site, branchName);
      batch.headSha = await createCommitObject(site, batch.headSha, files, message);
      batch.count += 1;
      recordFileOverlayWrites(site, branchName, files);
    } else {
      await commitFilesAtomic(site, branchName, files, message);
    }

    return { ok: true, branchName };
  } catch (err) {
    return persistedFailure('github-ops.pushDraftBranch', err, 'This change could not be pushed to a branch right now — our team has been notified.');
  }
}

// Opens a real PR restoring a draft's pre-merge snapshot — same "no direct/
// auto-merge onto production" rule as every other change: `main` auto-
// deploys on push (company CI/CD convention), so even an automated revert
// needs a human to review and merge it on GitHub, not this app merging
// straight to production unattended. Reuses the same existing-PR-reuse
// check as openPrForBranch since a retried rollback shouldn't 422.
export async function openRollbackPr(site, draft, branchName) {
  try {
    const existing = await listOpenPullRequestsForBranch(site, branchName);
    if (existing.length > 0) {
      const pr = existing[0];
      return { ok: true, prNumber: pr.number, prUrl: pr.html_url, reused: true };
    }

    const base = baseBranch(site);
    const { number, url } = await openPullRequest(site, {
      branch: branchName,
      title: `Action Center: rollback ${draft.action_type} draft #${draft.id}`,
      body: `Restores \`${draft.action_type}\` draft #${draft.id}'s file to exactly what it was right before `
          + `that draft's own PR was merged.\n\nReview the diff and merge into \`${base}\` to complete the rollback.`,
    });
    return { ok: true, prNumber: number, prUrl: url, reused: false };
  } catch (err) {
    return persistedFailure('github-ops.openRollbackPr', err, 'This rollback pull request could not be opened right now — our team has been notified.');
  }
}

// Opens a real PR from the batch branch into the site's default branch —
// never merges it; a human reviews and merges on GitHub. Since many drafts
// can now share one branch, this checks for an already-open PR on that
// branch first and reuses it instead of erroring on GitHub's "a PR already
// exists for this head" 422 — every draft approved the same day after the
// first one hits this reuse path.
export async function openPrForBranch(site, draft, branchName) {
  try {
    const existing = await listOpenPullRequestsForBranch(site, branchName);
    if (existing.length > 0) {
      const pr = existing[0];
      return { ok: true, prNumber: pr.number, prUrl: pr.html_url, reused: true };
    }

    const base = baseBranch(site);
    const { number, url } = await openPullRequest(site, {
      branch: branchName,
      title: `Action Center: batch for ${branchName}`,
      body: `Automated content batch for \`${branchName}\`, generated by the Action Center.\n\n`
          + `Review the diff and merge into \`${base}\` to publish. Additional drafts approved later today `
          + `will be added as new commits to this same branch/PR — check back before merging if you know `
          + `more drafts are still pending today.`,
    });
    return { ok: true, prNumber: number, prUrl: url, reused: false };
  } catch (err) {
    return persistedFailure('github-ops.openPrForBranch', err, 'This pull request could not be opened right now — our team has been notified.');
  }
}
