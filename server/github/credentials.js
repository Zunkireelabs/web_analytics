import { appConfigured, getInstallationToken } from './app-auth.js';

// THE one place a GitHub credential is resolved for a site.
//
// Before this module the rule `site.github_pat_env_var || 'GITHUB_PAT'` was
// written out at four separate call sites (client.js's searchToken,
// authHeaders and searchCodeForString, plus integrations/github.js). Four
// copies of a credential-resolution rule is how "we'll make it per-client
// later" turns into a change that updates three of them and leaves one client
// pushing with another client's token. Everything that needs a token now asks
// here.
//
// Deliberately ASYNC even though today's answer is a synchronous env lookup.
// The next credential source is a GitHub App installation token, which is
// minted over the network and cached — making the seam async now means adding
// it changes this file only, rather than re-touching every caller a second
// time.

// Which env var holds this site's PAT. Per-site by design (migration 028), with
// GITHUB_PAT as the default rather than a hardcoded constant — that column is
// what makes per-client credentials reachable without a code change.
export function githubTokenEnvVar(site) {
  return site?.github_pat_env_var || 'GITHUB_PAT';
}

// GitHub's Code Search API silently returns 0 results for a fine-grained PAT
// instead of an auth error, so it needs a classic token with `repo` scope. Kept
// separate from the main credential precisely so the main one can stay
// fine-grained and least-privilege. Per-site override first, then a global
// fallback, then nothing (callers treat null as "code search unavailable",
// never as "no results").
export function searchToken(site) {
  const envVar = githubTokenEnvVar(site);
  return process.env[`${envVar}_SEARCH`] || process.env.GITHUB_SEARCH_PAT || null;
}

export function isFineGrainedToken(token) {
  return typeof token === 'string' && token.startsWith('github_pat_');
}

// Whether this site is meant to authenticate as a GitHub App installation
// rather than with a PAT. Set by the tenant clicking "Install" on their repo
// (migration 106); NULL means the PAT path, which is every site today.
export function usesGithubApp(site) {
  return site?.github_app_installation_id != null;
}

// This tenant's own registered App identity, when it has one (migration 154),
// so its shipping run draws against its own GitHub API rate-limit budget
// instead of sharing the shared default App's. Returns null for every site
// that hasn't registered its own App — resolveGithubToken then falls back to
// the shared default App, exactly as before this existed. Never falls back
// itself: a site that declared a github_app_id but has no matching key env
// var comes back with privateKeyB64 unset, which appConfigured below reports
// as unconfigured rather than silently trying the wrong App's key.
function siteAppCredentials(site) {
  if (site?.github_app_id == null) return null;
  const envVar = site.github_app_private_key_env_var;
  return { appId: site.github_app_id, privateKeyB64: (envVar ? process.env[envVar] : null) ?? null };
}

// The credential this site should authenticate with, or null if none is
// available. Never throws for a missing credential — callers decide whether
// that is fatal (authHeaders) or merely disables a feature (code search).
//
// Precedence, and the reasoning for each step:
//
//  1. Code search NEVER uses an App installation token. GitHub's /search/code
//     needs a classic PAT with `repo` scope — a fine-grained PAT silently
//     returns zero results there, and an installation token (ghs_...) is no
//     better. Silently-zero is the worst possible failure for a search whose
//     caller treats "no matches" as a real answer, so search stays on its own
//     explicitly-configured classic token or nothing at all.
//
//  2. An installation id, when set, is AUTHORITATIVE — including when the App
//     is unconfigured, in which case this returns null rather than falling back
//     to the PAT. That is deliberate and is the security property of this
//     module: the PAT env var defaults to the shared GITHUB_PAT, so a silent
//     fallback would let a misconfigured deploy authenticate tenant B's repo
//     with tenant A's credential. Failing to find a credential is recoverable
//     and loud; using the wrong tenant's is neither.
//
//     Which App identity signs for that installation is itself resolved per
//     site (siteAppCredentials, migration 154): a tenant with their own
//     registered App uses it — and its own separate rate-limit budget —
//     while every other site keeps using the shared default App, unchanged.
//
//  3. Otherwise the per-site PAT, exactly as before.
export async function resolveGithubToken(site, { forSearch = false } = {}) {
  if (forSearch) return searchToken(site);

  if (usesGithubApp(site)) {
    const credentials = siteAppCredentials(site);
    if (!appConfigured(credentials)) return null;
    return getInstallationToken(site.github_app_installation_id, { credentials });
  }

  return process.env[githubTokenEnvVar(site)] || null;
}
