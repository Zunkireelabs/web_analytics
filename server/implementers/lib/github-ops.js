import { getBranchSha, createBranch, getFileSha, putFile, mergeBranch } from '../../github/client.js';

// Company convention (~/Travel/ci-cd-deployment-master-guide): `stage` has
// no protection rules and auto-deploys on push/merge — real PR review isn't
// required for it, only for `main` (production, which stays entirely
// outside this platform — a human promotes stage -> main on GitHub, on
// their own timeline). So the Action Center's real git integration forks
// from and merges directly into `stage`, never touching `main`. Exported so
// backend.js/frontend.js read the SAME real branch when fetching "current"
// content for a diff (preview) as pushDraftBranch actually forks from.
export const STAGE_BRANCH = 'stage';

// Two real, independently-triggered steps — deliberately NOT bundled. Staff
// needs a real manual checkpoint between "a branch with the real change
// exists" and "it's merged into stage (and therefore deployed)," so they
// can review the real pushed diff (dashboard's Draft Preview panel) first.
// Branch name is deterministic so a retried push targets the same branch
// instead of piling up duplicates (createBranch's 422-already-exists
// handling makes that safe to re-run).

export async function pushDraftBranch(site, draft, files) {
  const branchName = `action-center/${draft.action_type}-${draft.id}`;
  try {
    const baseSha = await getBranchSha(site, STAGE_BRANCH);
    await createBranch(site, branchName, baseSha);

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
