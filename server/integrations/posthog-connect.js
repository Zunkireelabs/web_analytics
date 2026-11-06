import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

// "Connect with PostHog": the person is sent to PostHog's own consent screen, signs in with THEIR PostHog account and
// approves READ access to their events. PostHog sends them back with a one-time code, which this exchanges for tokens
// that the project then keeps (server/store/project-posthog.js). Same shape as google-connect.js.
//
// How this app identifies itself to PostHog: a Client ID Metadata Document (CIMD, documented at
// https://posthog.com/docs/api/oauth). There is NO registration step and NO client secret. Our client_id is a URL on our
// own domain; PostHog fetches the JSON document served there (routes/projects.js, GET /posthog/oauth-client) to learn our
// name and our allowed redirect addresses. It is a PUBLIC client, so the code exchange is secured with PKCE instead of a
// secret. Consequence: PostHog must be able to reach that URL over HTTPS, so this only works on a public deployment, never
// on localhost (the connection screen shows "not set up on this server yet" there instead of failing mid-flow).
//
// Read-only on purpose: `query:read` (run the HogQL queries the nightly job needs) and `project:read` (list the projects the
// person may pick from). `openid email` only tells us WHICH account connected, to show "Connected as ...".

export const SCOPES = ['query:read', 'project:read'];
const IDENTITY_SCOPES = ['openid', 'email'];
export const REQUIRED_SCOPES = ['query:read', 'project:read'];

export const REGIONS = { us: 'https://us.posthog.com', eu: 'https://eu.posthog.com' };

export class PosthogConnectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Plain-English outcomes the Workspace page can show; also what the callback redirect carries as ?pherror=.
export const POSTHOG_ERRORS = {
  not_configured: 'Connecting PostHog is not set up on this server yet.',
  cancelled: 'PostHog sign-in was cancelled. Nothing was connected.',
  expired: 'That PostHog sign-in link expired. Start it again.',
  denied: 'You need to be a project admin to connect PostHog.',
  exchange_failed: 'PostHog did not accept the sign-in. Try again.',
  missing_scopes: 'Reading events and projects both need to be allowed on the PostHog screen. Try again and approve it in full.',
  no_refresh_token: 'PostHog did not return a long-lived sign-in. Try again and approve the screen in full.',
  bad_host: 'That PostHog address cannot be used. Use the full https address of your PostHog.',
  unreachable: 'PostHog could not be reached. Try again in a moment.',
};

const FETCH_TIMEOUT_MS = 15000;

// ── Identity of this client ──────────────────────────────────────────────────

// The client_id: a URL, and PostHog requires the `client_id` inside the document to match it character for character.
// POSTHOG_OAUTH_CLIENT_ID overrides it (needed when the app sits behind a proxy that hides its public address); otherwise it
// is built from the address the person is actually using.
export const clientIdFor = (origin, env = process.env) => env.POSTHOG_OAUTH_CLIENT_ID || `${origin}/api/posthog/oauth-client`;
export const redirectUriFor = (origin, env = process.env) => env.POSTHOG_OAUTH_REDIRECT_URI || `${origin}/api/posthog/callback`;

// PostHog refuses a client_id that is not https with a path, and cannot fetch a loopback address at all. Say "not set up"
// up front rather than send the person into a flow that is guaranteed to fail.
export function posthogConnectConfigured(origin, env = process.env) {
  try {
    const u = new URL(clientIdFor(origin, env));
    return u.protocol === 'https:' && u.pathname.length > 1 && !u.search && !u.hash && !isLoopbackHost(u.hostname);
  } catch { return false; }
}

// The document PostHog fetches. redirect_uris lists exactly the address we send people back to (PostHog matches it exactly).
export function clientMetadataDocument(origin, env = process.env) {
  return {
    client_id: clientIdFor(origin, env),
    client_name: 'SuperRank',
    client_uri: origin,
    redirect_uris: [redirectUriFor(origin, env)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: [...SCOPES, ...IDENTITY_SCOPES].join(' '),
    // Read-only ceiling: even if the authorize request were tampered with, a token for this client cannot carry more.
    'com.posthog': { scopes: [...SCOPES] },
  };
}

// ── Hosts ────────────────────────────────────────────────────────────────────

const isLoopbackHost = (h) => /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i.test(h) || /\.localhost$/i.test(h);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  return true;
}

/**
 * Check ONE PostHog address and return it normalised ("https://host[:port]"): https only, no credentials in it, not
 * loopback, not a private or link-local address, and not a NAME that resolves to one. A self-hosted address is typed by a
 * person (or stored from an earlier time) and this server will send a credential to it, so it is checked rather than
 * trusted: otherwise "connect PostHog" would be a way to make this server call internal addresses.
 *
 * Used when the address is CHOSEN (OAuth start, pasted key) and again before every request made to a STORED address, because
 * DNS can change after the choice. (A name that changes between this lookup and the request itself, DNS rebinding, is not
 * closed by a lookup-then-fetch; the redirect refusal and the fixed https-only rule keep the exposure small.)
 */
export async function validatePosthogHost(host, { lookup = dns.lookup } = {}) {
  const raw = String(host || '').trim();
  if (!raw) throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host);
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host); }
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || isLoopbackHost(u.hostname)) throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host);
  const origin = `${u.protocol}//${u.host}`;
  if (Object.values(REGIONS).includes(origin)) return origin; // PostHog's own cloud: nothing to look up
  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host);
  } else {
    let addrs;
    try { addrs = await lookup(u.hostname, { all: true }); } catch { throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host); }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new PosthogConnectError('bad_host', POSTHOG_ERRORS.bad_host);
  }
  return origin;
}

/** 'us', 'eu', or the person's own https address for a self-hosted instance (checked by validatePosthogHost). */
export async function resolveHost({ region, host }, { lookup = dns.lookup } = {}) {
  if (!region || region === 'us') return REGIONS.us;
  if (region === 'eu') return REGIONS.eu;
  return validatePosthogHost(host, { lookup });
}

// The check before a request to a STORED address. A short cache keeps the nightly job from doing a DNS lookup per query;
// only successes are cached, so a host that turns bad is refused again as soon as the cache entry lapses.
const GUARD_TTL_MS = 5 * 60 * 1000;
const guardCache = new Map();
export const forgetHostChecks = () => guardCache.clear();
/** null when the host is fine, else the failure to RETURN (never thrown: callers return failures). */
export async function hostGuard(host, { lookup = dns.lookup, now = Date.now() } = {}) {
  const hit = guardCache.get(host);
  if (hit && hit > now) return null;
  try { await validatePosthogHost(host, { lookup }); } catch (err) {
    return { ok: false, reason: 'bad_host', detail: POSTHOG_ERRORS.bad_host };
  }
  guardCache.set(host, now + GUARD_TTL_MS);
  return null;
}

// ── PKCE + state ─────────────────────────────────────────────────────────────

export const newConnectNonce = () => randomBytes(24).toString('base64url');
export const newCodeVerifier = () => randomBytes(32).toString('base64url');
export const codeChallengeFor = (verifier) => createHash('sha256').update(verifier).digest('base64url');

export function buildConsentUrl({ host, clientId, redirectUri, state, codeVerifier }) {
  const u = new URL(`${host}/oauth/authorize/`);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: [...SCOPES, ...IDENTITY_SCOPES].join(' '),
    code_challenge: codeChallengeFor(codeVerifier),
    code_challenge_method: 'S256',
    state,
  }).toString();
  return u.toString();
}

// ── Token endpoint ───────────────────────────────────────────────────────────

// A response that is a redirect is a failure, never followed: a validated address must not be able to bounce this server (and
// the credential it carries) to somewhere that was never checked.
const NO_REDIRECTS = { redirect: 'manual' };

async function tokenRequest(host, params, { fetchImpl = fetch } = {}) {
  const blocked = await hostGuard(host);
  if (blocked) return blocked;
  let res;
  try {
    res = await fetchImpl(`${host}/oauth/token/`, {
      ...NO_REDIRECTS,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    // Only the errors RFC 6749 §5.2 defines for a dead grant or client mean "reconnect": the person revoked access, it
    // expired, or this client is no longer known. Anything else (a malformed request, PostHog having a bad night, a
    // rate limit, a redirect) is transient and says nothing about the grant, so it must not mark the connection broken.
    const code = body?.error || `http_${res.status}`;
    const dead = ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(body?.error) || (res.status === 401 && !body?.error);
    return { ok: false, reason: dead ? 'unauthorized' : 'failed', error: code, detail: body?.error_description || `PostHog answered with an error (status ${res.status}).` };
  }
  if (!body?.access_token) return { ok: false, reason: 'failed', detail: 'PostHog returned no access token.' };
  return { ok: true, body };
}

const parseTokens = (body, now) => ({
  accessToken: body.access_token,
  // PostHog access tokens last an hour; refresh a little early so a long query never starts on a dying token.
  expiresAt: new Date(now + Math.max(60, Number(body.expires_in) || 3600) * 1000),
  refreshToken: body.refresh_token || null,
  scopes: String(body.scope || '').split(/\s+/).filter(Boolean),
  scopedTeams: Array.isArray(body.scoped_teams) ? body.scoped_teams.map(String) : null,
});

/** One-time code -> tokens, and who connected. Throws PosthogConnectError (the callback turns it into a redirect). */
export async function exchangeCode({ code, redirectUri, clientId, host, codeVerifier }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const out = await tokenRequest(host, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier,
  }, { fetchImpl });
  if (!out.ok) throw new PosthogConnectError(out.reason === 'unreachable' ? 'unreachable' : 'exchange_failed', POSTHOG_ERRORS[out.reason === 'unreachable' ? 'unreachable' : 'exchange_failed']);
  const t = parseTokens(out.body, now);
  const missing = REQUIRED_SCOPES.filter((s) => !t.scopes.includes(s));
  if (missing.length) throw new PosthogConnectError('missing_scopes', POSTHOG_ERRORS.missing_scopes);
  if (!t.refreshToken) throw new PosthogConnectError('no_refresh_token', POSTHOG_ERRORS.no_refresh_token);
  const email = await fetchEmail(host, t.accessToken, { fetchImpl });
  return { ...t, email };
}

/** Refresh token -> a new access token (and the rotated refresh token if PostHog issued one). Returned, never thrown. */
export async function refreshAccessToken({ host, refreshToken, clientId }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const out = await tokenRequest(host, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, { fetchImpl });
  if (!out.ok) return out;
  const t = parseTokens(out.body, now);
  return { ok: true, accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken || refreshToken };
}

// Display only: the connection is valid without it.
async function fetchEmail(host, accessToken, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${host}/oauth/userinfo/`, { ...NO_REDIRECTS, headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.email ? String(j.email) : null;
  } catch { return null; }
}

/** Best-effort: tell PostHog to forget the grant on disconnect. A failure here must never block disconnecting. */
export async function revokeToken({ host, token, clientId }, { fetchImpl = fetch } = {}) {
  try {
    if (await hostGuard(host)) return false;
    await fetchImpl(`${host}/oauth/revoke/`, {
      ...NO_REDIRECTS,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return true;
  } catch { return false; }
}

// ── Project list ─────────────────────────────────────────────────────────────

/**
 * The PostHog projects this sign-in can read, for the "which one is this website?" picker.
 * If the person limited the grant to specific projects on PostHog's screen (scoped_teams), only those are offered.
 */
export async function listProjects({ host, accessToken, scopedTeams = null }, { fetchImpl = fetch } = {}) {
  const blocked = await hostGuard(host);
  if (blocked) return blocked;
  let res;
  try {
    res = await fetchImpl(`${host}/api/projects/`, { ...NO_REDIRECTS, headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) { return { ok: false, reason: 'unreachable', detail: err.message }; }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', detail: `PostHog rejected the sign-in (HTTP ${res.status}).` };
  if (!res.ok) return { ok: false, reason: 'failed', detail: `PostHog answered with an error (status ${res.status}).` };
  let body = null;
  try { body = await res.json(); } catch { return { ok: false, reason: 'failed', detail: 'PostHog returned a response that was not JSON.' }; }
  const all = Array.isArray(body) ? body : (body?.results || []);
  const allowed = scopedTeams?.length ? new Set(scopedTeams.map(String)) : null;
  const projects = all
    .filter((p) => p && p.id != null && (!allowed || allowed.has(String(p.id))))
    .map((p) => ({ id: String(p.id), name: String(p.name || `Project ${p.id}`), url: p.app_urls?.[0] || null }));
  return { ok: true, projects };
}
