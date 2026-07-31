import crypto from 'node:crypto';
import { query } from '../db.js';

// Authorization codes for the OAuth 2.1 + PKCE flow (see mcp-server/
// oauth-provider.js). Same high-entropy-random / SHA-256-hash-only
// discipline as server/store/api-tokens.js.
//
// permission_level is passed in already computed by the caller
// (server/routes/oauth-consent.js, from sites.oauth_max_permission_level —
// see migration 061) — this module never derives it and never accepts a
// request-supplied override.
const CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes — long enough for a real browser redirect round-trip, short enough to limit replay exposure

function generateCode() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function createAuthorizationCode({ clientId, siteId, userId, redirectUri, codeChallenge, scope, permissionLevel, resource }) {
  const { raw, hash } = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await query(
    `INSERT INTO oauth_authorization_codes (code_hash, client_id, site_id, user_id, redirect_uri, code_challenge, scope, permission_level, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [hash, clientId, siteId, userId, redirectUri, codeChallenge, scope || null, permissionLevel, resource || null, expiresAt]
  );
  return raw;
}

// Sole lookup path used by the token exchange — excludes already-used and
// expired codes at the query level so a stale/replayed code simply doesn't
// match, same "fail closed on a missing row" shape as api_tokens.
export async function findActiveCodeByRawValue(rawCode) {
  const hash = crypto.createHash('sha256').update(rawCode).digest('hex');
  const { rows } = await query(
    `SELECT * FROM oauth_authorization_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hash]
  );
  return rows[0] || null;
}

// Only succeeds once — the second caller (a replay) gets 0 rows back even
// though the code was still otherwise valid a moment ago.
export async function consumeAuthorizationCode(id) {
  const { rows } = await query(
    `UPDATE oauth_authorization_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [id]
  );
  return rows.length > 0;
}
