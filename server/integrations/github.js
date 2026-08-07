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

    // PAT auth working doesn't mean drafts can actually apply — that also
    // needs url_file_map + live SEOAI markers to be populated (migration 028)
    // and verified (migration 088, server/scripts/audit-url-file-map.js).
    // Reuses recoveryAction (rather than a new field) so this reaches the
    // stored/polled listing too (store/upsert.js's recordIntegrationCheck
    // only persists errorMessage/recoveryAction) — ok stays true and
    // errorMessage stays null so it reads as "connected, review config"
    // rather than "broken".
    let recoveryAction = null;
    if (!full.action_center_config_checked_at) {
      recoveryAction = `url_file_map / marker config has never been audited. Run \`npm run audit-url-file-map -- --site-id ${full.id}\` before relying on drafts applying cleanly.`;
    } else if (full.action_center_config_gap_count > 0) {
      recoveryAction = `Last audit (${new Date(full.action_center_config_checked_at).toISOString().slice(0, 10)}) found ${full.action_center_config_gap_count} config gap(s). Run \`npm run audit-url-file-map -- --site-id ${full.id}\` for details.`;
    }

    return {
      ok: true,
      authStatus: 'valid',
      errorMessage: null,
      recoveryAction,
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
