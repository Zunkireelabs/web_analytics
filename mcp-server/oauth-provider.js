import crypto from 'node:crypto';
import { InvalidGrantError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { getClientById, registerClient } from '../server/store/oauth-clients.js';
import { createAuthorizationCode, findActiveCodeByRawValue, consumeAuthorizationCode } from '../server/store/oauth-authorization-codes.js';
import { createAccessToken, findActiveOauthAccessTokenByRawValue, revokeOauthAccessTokenByRawValue, revokeOauthAccessTokensForRefreshFamily } from '../server/store/oauth-access-tokens.js';
import { createRefreshToken, findRefreshTokenByRawValue, rotateRefreshToken, revokeRefreshTokenFamily, revokeRefreshTokenByRawValue } from '../server/store/oauth-refresh-tokens.js';
import { getSiteById } from '../server/store/read.js';
import { LEVEL_RANK, DEFAULT_PERMISSION_LEVEL } from './permissions.js';

// Implements the MCP SDK's OAuthServerProvider interface
// (@modelcontextprotocol/sdk/server/auth/provider.js), backed by Postgres via
// the store modules above. Mounted by mcp-server/routes/oauth.js.
//
// *** Permission-level derivation lives entirely in this file. ***
// The OAuth client, the browser, and the consent UI never determine
// permission_level — see computeEffectivePermissionLevel below, the only
// function in this codebase allowed to produce that value for an OAuth
// grant. Everywhere else (routes, store modules) either passes a value this
// function already computed, or refuses to accept one from a request at all.

// Client-requested scope (a space-delimited OAuth `scope` string, split into
// an array by the SDK before it reaches us) can only ever narrow the site's
// ceiling, never raise it — this is a `min`, not a lookup or an override.
function levelFromScopes(scopes) {
  if (!scopes || !scopes.length) return null;
  const known = scopes.filter((s) => s in LEVEL_RANK);
  if (!known.length) return null;
  return known.reduce((max, l) => (LEVEL_RANK[l] > LEVEL_RANK[max] ? l : max));
}

function minLevel(a, b) {
  if (!a) return b;
  if (!b) return a;
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

async function siteOauthCeiling(siteId) {
  const site = await getSiteById(siteId);
  if (!site) throw new ServerError('Site not found for this session.');
  return site.oauth_max_permission_level || DEFAULT_PERMISSION_LEVEL;
}

// Suspension check (PLATFORM-ADMIN-DESIGN.md §D, §I) — the fourth,
// structurally distinct enforcement point that requireMcpToken (mcp/auth.js)
// does not cover: token *issuance and refresh* happen here, reached via the
// OAuth token endpoint, never through requireMcpToken at all. Returns the
// fetched site (not just a boolean) so exchangeRefreshToken below can reuse
// it for the ceiling computation instead of fetching the row twice.
// InvalidGrantError, not ServerError — this is the same error shape the SDK
// already expects for "this token/grant is no good," and the OAuth client
// gets a normal token-endpoint error response rather than a 500.
async function requireActiveSite(siteId) {
  const site = await getSiteById(siteId);
  if (!site) throw new ServerError('Site not found for this session.');
  if (site.status !== 'active') {
    throw new InvalidGrantError('This tenant account is suspended.');
  }
  return site;
}

// The one function anything issuing or refreshing an OAuth grant should call
// to turn "what the client asked for" + "what this site is allowed
// (sites.oauth_max_permission_level, staff-set, migration 061)" into the
// level actually granted. Used at authorization-code issuance
// (server/routes/oauth-consent.js) and re-used at every refresh exchange
// below so a lowered site ceiling takes effect automatically.
export async function computeEffectivePermissionLevel(siteId, requestedScopes) {
  const ceiling = await siteOauthCeiling(siteId);
  const requested = levelFromScopes(requestedScopes);
  return minLevel(requested, ceiling);
}

export const clientsStore = {
  getClient: getClientById,
  registerClient,
};

export const oauthProvider = {
  clientsStore,

  // Protocol validation (client_id, redirect_uri, PKCE shape) has already
  // happened in the SDK's authorizationHandler by the time this runs. No
  // session check and no DB write here — that's the consent SPA's job
  // (server/routes/oauth-consent.js), reached via this redirect carrying
  // the validated params forward.
  async authorize(client, params, res) {
    const qs = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
    });
    if (params.state) qs.set('state', params.state);
    if (params.scopes && params.scopes.length) qs.set('scope', params.scopes.join(' '));
    if (params.resource) qs.set('resource', params.resource.href);
    // Absolute when set: this handler now also runs from the standalone MCP
    // process (mcp-server/index.js) on its own subdomain, but the consent
    // SPA (web/src/pages/OAuthAuthorize.jsx, route /oauth/authorize-consent)
    // only exists on the dashboard's own origin, with the dashboard's own
    // session cookie. DASHBOARD_ORIGIN points the browser back there.
    // Empty string when unset = today's relative-redirect behavior,
    // byte-identical for any deployment that hasn't split the MCP process out.
    const consentBase = process.env.DASHBOARD_ORIGIN || '';
    res.redirect(302, `${consentBase}/oauth/authorize-consent?${qs.toString()}`);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = await findActiveCodeByRawValue(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    // PKCE itself was already verified by the SDK's tokenHandler (via
    // challengeForAuthorizationCode above) before this is called.
    const row = await findActiveCodeByRawValue(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the one used to obtain this code.');
    }
    const consumed = await consumeAuthorizationCode(row.id);
    if (!consumed) {
      // Someone already exchanged this exact code between our lookup and
      // this call — a real race or a replay. Fail closed either way.
      throw new InvalidGrantError('This authorization code has already been used.');
    }

    // Blocks issuance for a tenant suspended between consent and this
    // exchange call — the code itself doesn't carry site status, so this
    // has to be checked fresh here, not inferred from anything on `row`.
    await requireActiveSite(row.site_id);

    // permission_level was already computed server-side when the code was
    // issued (server/routes/oauth-consent.js) — copied verbatim here, never
    // recomputed from anything in this request.
    const familyId = crypto.randomUUID();
    const [access, refresh] = await Promise.all([
      createAccessToken({
        clientId: client.client_id, siteId: row.site_id, userId: row.user_id,
        permissionLevel: row.permission_level, scope: row.scope, resource: row.resource,
        refreshFamilyId: familyId,
      }),
      createRefreshToken({
        clientId: client.client_id, siteId: row.site_id, userId: row.user_id,
        permissionLevel: row.permission_level, scope: row.scope, resource: row.resource,
        familyId,
      }),
    ]);

    return {
      access_token: access.token,
      token_type: 'bearer',
      expires_in: Math.max(0, Math.floor((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: refresh.token,
      scope: row.scope || undefined,
    };
  },

  async exchangeRefreshToken(client, refreshToken) {
    const row = await findRefreshTokenByRawValue(refreshToken);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token.');
    }
    if (row.revoked_at) {
      throw new InvalidGrantError('This refresh token has been revoked.');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new InvalidGrantError('This refresh token has expired.');
    }
    if (row.used_at) {
      // A refresh token that was already rotated away is being presented
      // again — a strong theft signal (either the legitimate client and an
      // attacker both have a copy, or this is a delayed replay). Kill the
      // entire chain, not just this one value, per OAuth 2.1 reuse-detection
      // guidance.
      await revokeRefreshTokenFamily(row.family_id);
      await revokeOauthAccessTokensForRefreshFamily(row.family_id);
      throw new InvalidGrantError('This refresh token has already been used. All tokens issued from this connection have been revoked.');
    }

    // requireActiveSite blocks refreshing a token for a tenant suspended
    // since original issuance — the one-time fetch it does is reused for
    // the ceiling computation below instead of fetching the row twice.
    const site = await requireActiveSite(row.site_id);

    // Re-derived against the site's CURRENT ceiling, not the level stamped
    // on this row at original issuance — so lowering a client's ceiling
    // (sites.oauth_max_permission_level) takes effect automatically on its
    // next refresh, with no need to hunt down and revoke individual
    // outstanding tokens. Never widened by anything in this request — a
    // client cannot use `scope` on a refresh request to climb back up.
    const ceiling = site.oauth_max_permission_level || DEFAULT_PERMISSION_LEVEL;
    const effectiveLevel = minLevel(row.permission_level, ceiling);

    const [rotated, access] = await Promise.all([
      rotateRefreshToken(row.id, {
        clientId: client.client_id, siteId: row.site_id, userId: row.user_id,
        permissionLevel: effectiveLevel, scope: row.scope, resource: row.resource,
        familyId: row.family_id,
      }),
      createAccessToken({
        clientId: client.client_id, siteId: row.site_id, userId: row.user_id,
        permissionLevel: effectiveLevel, scope: row.scope, resource: row.resource,
        refreshFamilyId: row.family_id,
      }),
    ]);

    return {
      access_token: access.token,
      token_type: 'bearer',
      expires_in: Math.max(0, Math.floor((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: rotated.token,
      scope: row.scope || undefined,
    };
  },

  // Not on requireMcpToken's hot path (mcp-server/auth.js calls the store
  // lookup directly, matching the manual-token path's shape) — this exists
  // to satisfy the SDK's OAuthTokenVerifier contract for any future/generic
  // caller (e.g. a token-introspection endpoint).
  async verifyAccessToken(token) {
    const row = await findActiveOauthAccessTokenByRawValue(token);
    if (!row) throw new InvalidGrantError('Invalid or expired access token.');
    return {
      token,
      clientId: row.client_id,
      scopes: [row.permission_level],
    };
  },

  // RFC 7009: revoking an already-invalid/unknown token is a no-op success,
  // not an error — tries both tables since the caller's token_type_hint is
  // only a hint, not authoritative.
  async revokeToken(_client, request) {
    const revokedAccess = await revokeOauthAccessTokenByRawValue(request.token);
    if (!revokedAccess) await revokeRefreshTokenByRawValue(request.token);
  },

  // PKCE is verified locally (the default) — we are the only authorization
  // server here, there's no upstream IdP to defer to.
  skipLocalPkceValidation: false,
};
