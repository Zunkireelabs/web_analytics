import crypto from 'node:crypto';
import { query } from '../db.js';

// OAuth-issued MCP access tokens. Prefixed distinctly from manual api_tokens
// (which are bare 64-hex-char, see server/store/api-tokens.js) so
// server/mcp/auth.js's requireMcpToken can dispatch to the right table by a
// cheap prefix check instead of querying both tables on every request.
export const OAUTH_ACCESS_TOKEN_PREFIX = 'mcp_oat_';
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function generateAccessToken() {
  const raw = OAUTH_ACCESS_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// permission_level/refreshFamilyId are passed in already computed by the
// caller (server/mcp/oauth-provider.js) — never derived here, never taken
// from a request parameter.
export async function createAccessToken({ clientId, siteId, userId, permissionLevel, scope, resource, refreshFamilyId }) {
  const { raw, hash } = generateAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const { rows } = await query(
    `INSERT INTO oauth_access_tokens (token_hash, client_id, site_id, user_id, permission_level, scope, resource, refresh_family_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [hash, clientId, siteId, userId, permissionLevel, scope || null, resource || null, refreshFamilyId || null, expiresAt]
  );
  return { id: rows[0].id, token: raw, expiresAt };
}

// Sole lookup path used by requireMcpToken — site_id always comes back FROM
// the row, exactly like findActiveTokenByRawValue in api-tokens.js. Expiry
// is checked here (unlike the manual-token table, which has none) so an
// expired-but-not-yet-cleaned-up row never authenticates a request.
export async function findActiveOauthAccessTokenByRawValue(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `SELECT id, site_id, permission_level, client_id FROM oauth_access_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash]
  );
  return rows[0] || null;
}

export async function touchOauthAccessTokenLastUsed(id) {
  await query(`UPDATE oauth_access_tokens SET last_used_at = now() WHERE id = $1`, [id]);
}

// Used by POST /oauth/revoke (RFC 7009) — token_type_hint may say
// "access_token", but per spec the server tries whatever type actually
// matches, so this and revokeRefreshTokenByRawValue are both attempted by
// the caller regardless of the hint.
export async function revokeOauthAccessTokenByRawValue(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `UPDATE oauth_access_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [hash]
  );
  return rows.length > 0;
}

// Reuse-detection fallout (server/mcp/oauth-provider.js's exchangeRefreshToken):
// every access token minted alongside a compromised refresh chain is killed
// in one query, keyed on the family_id they were stamped with at mint time.
export async function revokeOauthAccessTokensForRefreshFamily(refreshFamilyId) {
  await query(
    `UPDATE oauth_access_tokens SET revoked_at = now() WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
    [refreshFamilyId]
  );
}

// PLATFORM-ADMIN-DESIGN.md §E — disabling a user must actively revoke their
// OAuth grants, not leave them live until natural expiry: oauth_access_
// tokens.user_id only cascade-clears on a *hard* DELETE FROM users, never
// on a status update, so this direct UPDATE is the only thing that closes
// that gap. New user_id-scoped variant alongside the existing raw-value-
// scoped revokeOauthAccessTokenByRawValue above (that one's for RFC 7009
// client-initiated revocation of a single token; this one's for
// server-initiated revocation of everything a user holds).
export async function revokeOauthAccessTokensForUser(userId) {
  await query(
    `UPDATE oauth_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}
