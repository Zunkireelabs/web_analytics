import { getBranchSha, createBranch, getFileSha, putFile, openPullRequest, listOpenPullRequestsForBranch, defaultBranchName } from '../../github/client.js';

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
export function batchBranchName(site, date = new Date()) {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `action-center/batch-${site.id}-${day}`;
}

// Detects whether today's batch branch already has commits (i.e. this is
// NOT the first draft pushed today) vs. needs to be created fresh from the
// site's default branch. GitHub's 404 body for a missing ref is the standard
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
  const { branchName, exists } = target;
  try {
    if (!exists) {
      const baseSha = await getBranchSha(site, baseBranch(site));
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
    return { ok: false, reason: 'github-error', error: err.message };
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
    return { ok: false, reason: 'github-error', error: err.message };
  }
}
