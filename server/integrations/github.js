import { getSiteById } from '../store/read.js';
import { getDefaultBranchSha, getTokenExpiry } from '../github/client.js';
import { resolveGithubToken, githubTokenEnvVar } from '../github/credentials.js';

// How far ahead to start warning. Long enough that a person has time to
// generate a replacement and update both copies of it (the app's env and the
// deploy secret) without urgency; short enough not to nag for most of the
// token's life.
const EXPIRY_WARNING_DAYS = Number(process.env.GITHUB_PAT_EXPIRY_WARNING_DAYS || 14);

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
  const envVar = githubTokenEnvVar(full);
  if (!await resolveGithubToken(full)) {
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
    // Expiry is checked BEFORE the config-gap advice below, and wins when both
    // apply: a config gap makes some drafts fail, an expired token makes every
    // one of them fail. Warning only inside the window keeps this quiet the
    // other ~11 months of a token's life.
    let recoveryAction = null;
    const expiresAt = await getTokenExpiry(full).catch(() => null); // never fail the check over the warning
    const daysLeft = expiresAt ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null;
    if (daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS) {
      recoveryAction = `This site's GitHub token expires in ${daysLeft} day(s), on ${expiresAt.toISOString().slice(0, 10)}. Generate a replacement (Contents + Pull requests, read/write, scoped to ${full.repo_owner}/${full.repo_name}) and update ${envVar} before then — when it lapses, the Action Center silently stops opening pull requests.`;
    } else if (!full.action_center_config_checked_at) {
      recoveryAction = `url_file_map / marker config has never been audited. Run \`npm run audit-url-file-map -- --site-id ${full.id}\` before relying on drafts applying cleanly.`;
    } else if (full.action_center_config_gap_count > 0) {
      recoveryAction = `Last audit (${new Date(full.action_center_config_checked_at).toISOString().slice(0, 10)}) found ${full.action_center_config_gap_count} config gap(s). Run \`npm run audit-url-file-map -- --site-id ${full.id}\` for details.`;
    }

    return {
      ok: true,
      authStatus: 'valid',
      errorMessage: null,
      recoveryAction,
      detail: { repo: `${full.repo_owner}/${full.repo_name}`, defaultBranchSha: sha, tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null, tokenExpiresInDays: daysLeft },
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
