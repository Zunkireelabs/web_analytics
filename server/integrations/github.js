import { getSiteById } from '../store/read.js';
import { getDefaultBranchSha } from '../github/client.js';

export const meta = {
  id: 'github',
  label: 'GitHub (Action Center)',
  category: 'github',
  description: 'PAT-based connection used by the Action Center to apply approved drafts as real pull requests against a site\'s own repo.',
};

// Live, read-only diagnostic: confirms the site has a repo configured and its
// PAT can actually reach it. A site with no repo configured reports ok:false
// with a distinct, non-alarming reason (not "broken," just "not set up yet")
// so it doesn't read like an outage on sites that were never meant to have this.
export async function check(site) {
  const full = await getSiteById(site.id);
  if (!full?.repo_owner || !full?.repo_name) {
    return {
      ok: false,
      authStatus: 'not-configured',
      errorMessage: 'No repository configured for this site yet.',
      recoveryAction: 'Run `npm run connect-repo` to attach a GitHub repo to this site.',
    };
  }
  const envVar = full.github_pat_env_var || 'GITHUB_PAT';
  if (!process.env[envVar]) {
    return {
      ok: false,
      authStatus: 'not-configured',
      errorMessage: `No GitHub PAT set in env var "${envVar}".`,
      recoveryAction: `Generate a fine-grained PAT (Contents + Pull requests, read/write) scoped to ${full.repo_owner}/${full.repo_name} and set it as ${envVar}.`,
    };
  }
  try {
    const sha = await getDefaultBranchSha(full);
    return {
      ok: true,
      authStatus: 'valid',
      errorMessage: null,
      recoveryAction: null,
      detail: { repo: `${full.repo_owner}/${full.repo_name}`, defaultBranchSha: sha },
    };
  } catch (err) {
    const authError = /401|403/.test(err.message);
    return {
      ok: false,
      authStatus: authError ? 'revoked' : 'unknown',
      errorMessage: err.message,
      recoveryAction: authError
        ? `Check that the ${envVar} token is valid and has contents+pull-requests access to ${full.repo_owner}/${full.repo_name}.`
        : null,
    };
  }
}
