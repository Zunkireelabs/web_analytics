import { getBranchSha } from '../github/client.js';
import { updateSiteRepoConfig } from '../db.js';

// Finds out whether a client's repository has a stage branch and, if so, records it as the branch the agent's pull requests may be
// opened into (sites.pr_target_branch). Without this the routing rule (light edits to main; new pages, translations, blogs and
// site-wide fixes to stage; see pr-routing.js) only works for a client someone remembered to configure by hand.
//
// Rules: only when pr_target_branch is empty (a person's setting is never overwritten); only a branch literally named `stage`
// (or `staging`) that exists and is not the default branch. A repository with no such branch stays as it is, so its pull requests
// go to the default branch.

export const STAGE_BRANCH_NAMES = Object.freeze(['stage', 'staging']);

export async function detectStageBranch(site, { deps = {} } = {}) {
  const branchSha = deps.getBranchSha || getBranchSha;
  const save = deps.updateSiteRepoConfig || updateSiteRepoConfig;
  if (site.pr_target_branch) return { changed: false, reason: 'already-set', branch: site.pr_target_branch };
  if (!site.repo_owner || !site.repo_name) return { changed: false, reason: 'no-repo' };
  const base = site.repo_default_branch || 'main';
  for (const name of STAGE_BRANCH_NAMES) {
    if (name === base) continue;
    let exists = false;
    try { await branchSha(site, name); exists = true; } catch { exists = false; }
    if (!exists) continue;
    await save({ siteId: site.id, prTargetBranch: name });
    return { changed: true, branch: name };
  }
  return { changed: false, reason: 'no-stage-branch' };
}
