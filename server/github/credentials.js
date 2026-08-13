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

// The credential this site should authenticate with, or null if none is
// configured. Never throws — callers decide whether a missing credential is
// fatal (authHeaders) or merely disables a feature (code search).
export async function resolveGithubToken(site, { forSearch = false } = {}) {
  if (forSearch) {
    const search = searchToken(site);
    if (search) return search;
  }
  return process.env[githubTokenEnvVar(site)] || null;
}
