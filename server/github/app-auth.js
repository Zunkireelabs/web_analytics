import { createSign } from 'node:crypto';

// GitHub App authentication: the credential path that lets a tenant grant
// access by clicking "Install" on their own repo, instead of generating a PAT
// and emailing it to us.
//
// Two-step, per GitHub's design:
//   1. Sign a short-lived JWT with the App's private key — this authenticates
//      the APP itself, not any particular repo.
//   2. Exchange that JWT for an INSTALLATION token, which is scoped to exactly
//      the repos one tenant installed the App on, and expires in an hour.
//
// The second step is what makes this worth building: nothing long-lived is ever
// stored per tenant, so there is no per-client secret to provision and no expiry
// date to chase. Contrast the PAT path, where site 1's token lapsing silently
// stopped the autonomous chain for two days.
//
// Signed with node:crypto rather than a JWT library on purpose: RS256 here is
// about fifteen lines, and the only JWT package currently resolvable in this
// project is a transitive dependency of google-auth-library — depending on
// something we do not declare is how a transitive bump becomes an outage.

const API_BASE = 'https://api.github.com';

// GitHub rejects an App JWT with more than 10 minutes of life. 9 leaves room
// for the clock skew allowance below without ever crossing that limit.
const JWT_LIFETIME_S = 9 * 60;
// GitHub also rejects a JWT whose `iat` is in the future by its clock. Backdating
// a minute absorbs ordinary drift between this host and theirs.
const JWT_CLOCK_SKEW_S = 60;
// Installation tokens last an hour. Refreshing with this much left avoids the
// case where a token passes the check and then expires mid-request.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

// installationId -> { token, expiresAt }. In-process only, deliberately: a
// restart just re-mints, and persisting a live credential to disk or the
// database would reintroduce exactly the "stored long-lived secret" problem
// this path exists to remove.
const tokenCache = new Map();

function privateKeyFromEnv() {
  // Base64 is the primary form because the deploy writes .env wholesale and a
  // PEM's newlines do not survive that intact. A raw PEM is still accepted for
  // local development, where a multi-line value is workable.
  const encoded = process.env.GITHUB_APP_PRIVATE_KEY_B64;
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
  return process.env.GITHUB_APP_PRIVATE_KEY || null;
}

// Resolves which App identity to sign with. `credentials` is an explicit
// { appId, privateKeyB64 } pair for a tenant with their own registered App
// (migration 154); omitted (the default for every call site that predates
// per-client Apps) it reads the shared default App from env, exactly as
// before this per-client path existed. Deliberately no merging between the
// two — a site that declared its own App id but has no matching key must
// fail closed, not silently sign with the shared default App's key against
// its own (different) App id, which would just fail confusingly at GitHub
// instead of here.
function resolveCredentials(credentials) {
  if (credentials) {
    const key = credentials.privateKeyB64
      ? Buffer.from(credentials.privateKeyB64, 'base64').toString('utf8')
      : null;
    return { appId: credentials.appId || null, key };
  }
  return { appId: process.env.GITHUB_APP_ID || null, key: privateKeyFromEnv() };
}

// Whether App auth is usable at all. Callers use this to decide between the App
// and PAT paths without having to catch a configuration error.
export function appConfigured(credentials = null) {
  const { appId, key } = resolveCredentials(credentials);
  return Boolean(appId && key);
}

const b64url = (input) => Buffer.from(input).toString('base64url');

// A signed App JWT. Exported for tests and diagnostics; normal callers want
// getInstallationToken below.
export function createAppJwt(now = Date.now(), credentials = null) {
  const { appId, key } = resolveCredentials(credentials);
  if (!appId || !key) {
    throw new Error(credentials
      ? `GitHub App ${credentials.appId || '(unknown)'} is not configured for this site — check its App id and private key env var.`
      : 'GitHub App is not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64.');
  }
  const issuedAt = Math.floor(now / 1000) - JWT_CLOCK_SKEW_S;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + JWT_LIFETIME_S, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

// A token scoped to one tenant's installation, cached until shortly before it
// expires. Throws if the App is unconfigured or GitHub refuses — never returns a
// token belonging to a different installation, which is the whole point.
export async function getInstallationToken(installationId, { fetchImpl = fetch, now = Date.now, credentials = null } = {}) {
  if (!installationId) throw new Error('An installation id is required to mint a GitHub App token.');

  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;

  const res = await fetchImpl(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAppJwt(now(), credentials)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    // Status only — a failure body from this endpoint can echo App identifiers,
    // and this message reaches ordinary error handling.
    throw new Error(`Could not mint a GitHub App installation token for installation ${installationId} (HTTP ${res.status}).`);
  }

  const data = await res.json();
  if (!data?.token) throw new Error(`GitHub returned no token for installation ${installationId}.`);

  tokenCache.set(installationId, {
    token: data.token,
    // Trust GitHub's own expiry when given; otherwise assume the documented
    // hour. Never assume longer than GitHub states.
    expiresAt: data.expires_at ? Date.parse(data.expires_at) : now() + 60 * 60 * 1000,
  });
  return data.token;
}

// Test seam, and a way to force a re-mint if an installation's access changes
// mid-process (a tenant revoking and re-granting, say).
export function clearInstallationTokenCache(installationId = null) {
  if (installationId === null) tokenCache.clear();
  else tokenCache.delete(installationId);
}
