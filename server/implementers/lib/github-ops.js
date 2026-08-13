import { getBranchSha, createBranch, commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch, defaultBranchName, mergeBranchFromBase } from '../../github/client.js';
import { safeMessage } from '../../lib/errors.js';
import { validateRenderingBatch } from './rendering-gate.js';

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
function persistedFailure(context, err, fallback) {
  const { message, id } = safeMessage(context, err, fallback);
  return { ok: false, reason: 'github-error', error: `${message} (ref: ${id})` };
}

export function batchBranchName(site, date = new Date()) {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
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
  let exists;
  try {
    await getBranchSha(site, branchName);
    exists = true;
  } catch (err) {
    if (/404|Not Found/i.test(err.message)) exists = false;
    else throw err;
  }
  if (!exists) return { branchName, exists: false, conflicted: false };

  const synced = await mergeBranchFromBase(site, branchName, baseBranch(site));
  return { branchName, exists: true, conflicted: !synced.ok };
}

// Shared, consistent failure shape for every apply()/preview() call site
// that checks `batchInfo.conflicted` right after getOrInitBatchBranch —
// same {ok, reason, error} contract as every other honest-failure return in
// this app (e.g. render-mode-uncertain), so it flows through recordApply-
// Failure/sendHttpError exactly like any other apply() failure.
export function batchBranchConflictError(site, batchInfo) {
  return {
    ok: false, reason: 'batch-branch-conflicted',
    error: `Today's batch branch (${batchInfo.branchName}) has diverged from ${baseBranch(site)} and couldn't be auto-synced — resolve the conflict manually on GitHub before more drafts can be pushed today.`,
  };
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
    if (!exists) {
      const baseSha = await getBranchSha(site, baseBranch(site));
      await createBranch(site, branchName, baseSha);
    }

    // One atomic commit for all of this draft's files (Git Data API:
    // tree -> commit -> ref update) — either every file lands together or
    // the branch never moves, so a mid-write failure can never leave an
    // earlier file's change stranded on the shared batch branch owned by no
    // draft (see commitFilesAtomic's comment). Replaces a previous
    // sequential getFileSha+putFile-per-file loop, which had exactly that
    // gap for multi-file draft types (llms-txt+robots.txt, broken-link-fix).
    await commitFilesAtomic(
      site, branchName, files,
      `Action Center: apply ${draft.action_type} draft #${draft.id}`
    );

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
