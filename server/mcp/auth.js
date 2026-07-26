import { findActiveTokenByRawValue, touchApiTokenLastUsed } from '../store/api-tokens.js';
import { OAUTH_ACCESS_TOKEN_PREFIX, findActiveOauthAccessTokenByRawValue, touchOauthAccessTokenLastUsed } from '../store/oauth-access-tokens.js';
import { getSiteStatus } from '../store/read.js';

// Tiny in-memory sliding-window limiter, keyed by token id. No rate
// limiting exists anywhere else in this app today — this is a minimal
// first line of defense for a newly internet-facing endpoint, not a
// production-grade limiter. Per-process (fine at current single-instance
// scale); revisit if this ever runs multi-instance.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const hits = new Map(); // tokenId -> number[] (timestamps)

function isRateLimited(tokenId) {
  const now = Date.now();
  const arr = (hits.get(tokenId) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(tokenId, arr);
  return arr.length > MAX_REQUESTS_PER_WINDOW;
}

// Separate, stricter, IP-keyed limiter for requests that never reach a
// valid token — a missing/malformed header or a hash lookup that misses.
// Without this, a flood of garbage bearer values hits findActiveTokenByRawValue
// (one DB query each) with zero throttling, since isRateLimited() above only
// ever sees requests that already found a real, unrevoked token — this is
// the one endpoint in the app reachable with no session cookie at all, so
// it's also the one place an unauthenticated caller can drive unbounded DB
// load today. Only failed-auth outcomes count against this bucket; a
// shared IP running many *valid* tokens (e.g. behind a corporate NAT) is
// never penalized by it.
const INVALID_WINDOW_MS = 60_000;
const MAX_INVALID_ATTEMPTS_PER_WINDOW = 20;
const invalidAttempts = new Map(); // ip -> number[] (timestamps)

function tooManyInvalidAttempts(ip) {
  const now = Date.now();
  const arr = (invalidAttempts.get(ip) || []).filter((t) => now - t < INVALID_WINDOW_MS);
  invalidAttempts.set(ip, arr);
  return arr.length >= MAX_INVALID_ATTEMPTS_PER_WINDOW;
}

function recordInvalidAttempt(ip) {
  const arr = invalidAttempts.get(ip) || [];
  arr.push(Date.now());
  invalidAttempts.set(ip, arr);
}

// Both maps above only ever grow on their own — isRateLimited/
// recordInvalidAttempt always re-`set()` a non-empty array, so a token or
// IP that goes permanently idle (revoked token, one-off bad actor) leaves a
// small array parked in memory forever instead of shrinking back out. This
// periodic sweep drops any key whose newest hit has aged out of its window,
// so both maps stay bounded by *currently active* callers, not by
// everything ever seen over the process's lifetime. unref()'d so this timer
// never keeps the process alive on its own (e.g. in short-lived scripts).
function sweepStale(map, windowMs) {
  const now = Date.now();
  for (const [key, timestamps] of map) {
    const fresh = timestamps.filter((t) => now - t < windowMs);
    if (fresh.length === 0) map.delete(key); else map.set(key, fresh);
  }
}
setInterval(() => {
  sweepStale(hits, WINDOW_MS);
  sweepStale(invalidAttempts, INVALID_WINDOW_MS);
}, Math.max(WINDOW_MS, INVALID_WINDOW_MS)).unref();

// The sole origin of siteId/permission_level for any MCP request — mirrors
// requireAuth's guarantee that downstream code never needs to (and can't)
// trust a client-supplied site or level param. No req.session read: an MCP
// client has no cookie, only its bearer token.
export async function requireMcpToken(req, res, next) {
  if (tooManyInvalidAttempts(req.ip)) {
    return res.status(429).json({ error: 'Too many invalid attempts. Try again shortly.' });
  }

  const header = req.get('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!raw) {
    recordInvalidAttempt(req.ip);
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  // OAuth-issued access tokens (server/mcp/oauth-provider.js) carry a
  // distinct prefix so this dispatches on a cheap string check instead of
  // querying both tables on every request. Manual tokens (server/store/
  // api-tokens.js) are bare 64-hex-char with no prefix — that lookup path
  // below is completely unmodified from before OAuth existed.
  const isOauthToken = raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
  const tokenRow = isOauthToken // no caching either way — revocation must be immediate
    ? await findActiveOauthAccessTokenByRawValue(raw)
    : await findActiveTokenByRawValue(raw);
  if (!tokenRow) {
    recordInvalidAttempt(req.ip);
    return res.status(401).json({ error: 'Invalid or revoked token.' });
  }

  // Suspension check (PLATFORM-ADMIN-DESIGN.md §D, §I) — this is the shared
  // convergence point for BOTH manual api_tokens and already-issued OAuth
  // access tokens (the isOauthToken branch above only decides which table
  // tokenRow came from; every request from here down is one code path), so
  // this single check covers both token types in the way §A's audit found:
  // one code change, not two. A suspended/soft-deleted site's outstanding
  // tokens keep validating against their own table right up until this
  // check — they are not separately revoked — this is what blocks them.
  const siteStatus = await getSiteStatus(tokenRow.site_id);
  if (siteStatus !== 'active') {
    return res.status(403).json({ error: 'This site is suspended.' });
  }

  if (isRateLimited(tokenRow.id)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  }

  req.mcpSiteId = tokenRow.site_id;
  req.mcpTokenId = tokenRow.id;
  req.mcpPermissionLevel = tokenRow.permission_level;
  // best-effort, never blocks the request
  (isOauthToken ? touchOauthAccessTokenLastUsed(tokenRow.id) : touchApiTokenLastUsed(tokenRow.id)).catch(() => {});
  next();
}
