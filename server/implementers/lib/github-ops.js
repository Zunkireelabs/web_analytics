import { getBranchSha, createBranch, getFileSha, putFile, mergeBranch, openPullRequest, listOpenPullRequestsForBranch } from '../../github/client.js';

// Company convention (~/Travel/ci-cd-deployment-master-guide): `stage` has
// no protection rules and auto-deploys on push/merge, so it's still the
// safe, cheap base every draft branch forks from and diffs against.
// Publishing a draft, though, now opens a real PR into `main` (see
// openPrForBranch below) instead of merging straight into `stage` — a human
// reviews and merges it on GitHub. Because the branch is forked from
// `stage` but the PR targets `main`, if a given client's `stage` has
// diverged from `main` (not promoted in a while), the PR diff will include
// that unrelated divergence too, not just this draft's change — that's
// intentional: it's surfaced to the human reviewer via the PR itself, which
// is the whole point of requiring manual review, not something this layer
// tries to rebase away. Exported so backend.js/frontend.js read the SAME
// real branch when fetching "current" content for a diff (preview) as
// pushDraftBranch actually forks from.
export const STAGE_BRANCH = 'stage';

// Deterministic per-site, per-calendar-day branch name. Strict day-boundary-
// keyed by design — NOT "reuse until merged": a new branch starts every day
// regardless of whether yesterday's branch/PR was ever merged, which can
// leave a prior day's branch/PR open and orphaned forever if nobody merges
// it — that's accepted, not a bug (see openPrForBranch's PR body, which
// surfaces this to the human reviewer). UTC date, so behavior is identical
// regardless of server locale/deploy region.
export function batchBranchName(site, date = new Date()) {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `action-center/batch-${site.id}-${day}`;
}

// Detects whether today's batch branch already has commits (i.e. this is
// NOT the first draft pushed today) vs. needs to be created fresh from
// stage. GitHub's 404 body for a missing ref is the standard
// `{"message":"Not Found",...}` shape — same body-sniffing convention
// createBranch below already uses for its 422 case.
export async function getOrInitBatchBranch(site, date = new Date()) {
  const branchName = batchBranchName(site, date);
  try {
    await getBranchSha(site, branchName);
    return { branchName, exists: true };
  } catch (err) {
    if (/404|Not Found/i.test(err.message)) return { branchName, exists: false };
    throw err;
  }
}

// Two real, independently-triggered steps — deliberately NOT bundled. Staff
// needs a real manual checkpoint between "a branch with the real change
// exists" and "it's merged into stage (and therefore deployed)," so they
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
  const { branchName, exists } = target;
  try {
    if (!exists) {
      const baseSha = await getBranchSha(site, STAGE_BRANCH);
      await createBranch(site, branchName, baseSha);
    }

    for (const f of files) {
      const sha = await getFileSha(site, f.path, branchName);
      await putFile(site, {
        path: f.path,
        content: f.content,
        message: `Action Center: apply ${draft.action_type} draft #${draft.id}`,
        branch: branchName,
        sha,
      });
    }

    return { ok: true, branchName };
  } catch (err) {
    return { ok: false, reason: 'github-error', error: err.message };
  }
}

export async function mergeBranchToStage(site, draft, branchName) {
  try {
    const result = await mergeBranch(site, {
      base: STAGE_BRANCH,
      head: branchName,
      commitMessage: `Action Center: merge ${draft.action_type} draft #${draft.id} into stage`,
    });
    return { ok: true, mergeSha: result.sha, mergeUrl: result.htmlUrl, alreadyMerged: result.alreadyMerged };
  } catch (err) {
    return { ok: false, reason: 'github-error', error: err.message };
  }
}

// Opens a real PR from the batch branch into `main` — never merges it; a
// human reviews and merges on GitHub (see STAGE_BRANCH comment above for why
// the diff can include unrelated stage/main divergence). Since many drafts
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

    const { number, url } = await openPullRequest(site, {
      branch: branchName,
      title: `Action Center: batch for ${branchName}`,
      body: `Automated content batch for \`${branchName}\`, generated by the Action Center.\n\n`
          + `Review the diff and merge into \`main\` to publish. Additional drafts approved later today `
          + `will be added as new commits to this same branch/PR — check back before merging if you know `
          + `more drafts are still pending today.\n\n`
          + `**Note:** this branch was forked from \`stage\`, not \`main\` — if \`stage\` has diverged from `
          + `\`main\`, the diff below may include unrelated changes on top of this batch's actual edits. Review accordingly.`,
    });
    return { ok: true, prNumber: number, prUrl: url, reused: false };
  } catch (err) {
    return { ok: false, reason: 'github-error', error: err.message };
  }
}
