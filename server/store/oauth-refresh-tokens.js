import crypto from 'node:crypto';
import { pool, query } from '../db.js';

// Refresh tokens with mandatory rotate-on-use (OAuth 2.1 requirement for
// public clients) and reuse detection. permission_level is always passed in
// already computed by the caller (server/mcp/oauth-provider.js) — never
// derived here from anything in the refresh request.
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, sliding — reset on every rotation

function generateRefreshToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// Only used for the very first refresh token in a family (minted alongside
// an authorization code); every later one in the same chain goes through
// rotateRefreshToken below, which reuses the family_id instead of calling this.
export async function createRefreshToken({ clientId, siteId, userId, permissionLevel, scope, resource, familyId }) {
  const { raw, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const family = familyId || crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, site_id, user_id, permission_level, scope, resource, family_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [hash, clientId, siteId, userId, permissionLevel, scope || null, resource || null, family, expiresAt]
  );
  return { id: rows[0].id, token: raw, familyId: family, expiresAt };
}

// Returns the full row (including used_at/revoked_at/expires_at) so the
// caller can distinguish "not found", "expired", "already rotated away
// (reuse!)", and "revoked" — each needs different handling in
// exchangeRefreshToken, not just a single valid/invalid boolean.
export async function findRefreshTokenByRawValue(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1`, [hash]);
  return rows[0] || null;
}

// Atomically marks `oldId` consumed + linked forward, and inserts its
// replacement in the same family. The caller (exchangeRefreshToken) must
// have already verified the old token is unused/unrevoked/unexpired before
// calling this — this function does not re-check any of that itself, it
// only performs the mechanical rotation.
export async function rotateRefreshToken(oldId, { clientId, siteId, userId, permissionLevel, scope, resource, familyId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { raw, hash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const inserted = await client.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, site_id, user_id, permission_level, scope, resource, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [hash, clientId, siteId, userId, permissionLevel, scope || null, resource || null, familyId, expiresAt]
    );
    const newId = inserted.rows[0].id;
    await client.query(
      `UPDATE oauth_refresh_tokens SET used_at = now(), rotated_to_id = $1 WHERE id = $2`,
      [newId, oldId]
    );
    await client.query('COMMIT');
    return { id: newId, token: raw, familyId, expiresAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Reuse-detection response: kill the entire chain a stolen token belongs to,
// not just the one presented value — see exchangeRefreshToken.
export async function revokeRefreshTokenFamily(familyId) {
  await query(`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}

export async function revokeRefreshTokenByRawValue(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [hash]
  );
  return rows.length > 0;
}

// PLATFORM-ADMIN-DESIGN.md §E — same user_id-scoped counterpart to
// revokeOauthAccessTokensForUser above (server/store/oauth-access-tokens.js)
// so disabling a user kills both halves of any outstanding OAuth grant, not
// just the shorter-lived access token.
export async function revokeOauthRefreshTokensForUser(userId) {
  await query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}
