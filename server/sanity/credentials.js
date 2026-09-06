// THE one place a Sanity credential is resolved for a site.
//
// Deliberately modelled on server/github/credentials.js, which exists because
// the rule `site.github_pat_env_var || 'GITHUB_PAT'` had been copy-pasted to
// four call sites, and — in that module's own words — "four copies of a
// credential-resolution rule is how 'we'll make it per-client later' turns
// into a change that updates three of them and leaves one client pushing with
// another client's token." Starting with one resolver costs nothing now and
// avoids repeating that.
//
// THE SECURITY PROPERTY OF THIS MODULE: there is no fallback. A site with no
// sanity_write_token_env_var, or one naming an env var that isn't set, gets
// null — never a shared or default token. This is a stronger rule than the
// GitHub side's, on purpose: github_pat_env_var defaults to a shared
// 'GITHUB_PAT', which migration 106 documents as a known scaling problem, and
// a Sanity token is worse to share because it is scoped to a specific project
// and dataset. A "working" shared Sanity token would mean writing tenant A's
// generated content into tenant B's CMS.
//
// Never throws for a missing credential — callers decide whether that's fatal.
// For the adapter it is: no credential means an honest {ok:false} return, the
// same as any other foreseeable failure (see implementers/types.js).
//
// resolveSanityToken is async even though today's answer is a synchronous env
// lookup, for the same reason resolveGithubToken is: if a credential ever
// comes from somewhere that needs a network call (a vault, a short-lived
// minted token), that changes this file only.

export function sanityTokenEnvVar(site) {
  return site?.sanity_write_token_env_var || null;
}

export function siteHasSanityWriteCapability(site) {
  return !!sanityTokenEnvVar(site);
}

export async function resolveSanityToken(site) {
  const envVar = sanityTokenEnvVar(site);
  if (!envVar) return null;
  return process.env[envVar] || null;
}

// Why a credential is unavailable, for an honest failure message. Separates
// "this site was never configured for Sanity" from "it was configured, but the
// env var it names isn't set in this environment" — the second is a deploy
// mistake and should read like one rather than looking like a missing feature.
export async function describeSanityCredentialGap(site) {
  const envVar = sanityTokenEnvVar(site);
  if (!envVar) {
    return {
      reason: 'sanity-not-configured',
      error: `Site ${site?.id ?? '?'} has no sanity_write_token_env_var — it has no Sanity write capability configured.`,
    };
  }
  if (!process.env[envVar]) {
    return {
      reason: 'sanity-credential-missing',
      error: `Site ${site?.id ?? '?'} is configured to use env var ${envVar} for its Sanity token, but that variable is not set in this environment.`,
    };
  }
  return null;
}
