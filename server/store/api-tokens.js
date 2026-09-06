import crypto from 'node:crypto';
import { query } from '../db.js';
import { DEFAULT_PERMISSION_LEVEL } from '../../mcp-server/permissions.js';

// Bearer tokens for the MCP endpoint (see mcp-server/auth.js). One token
// maps to exactly one site — same isolation model as session auth, just
// token- instead of cookie-based. Each token also carries a permission_level
// (mcp-server/permissions.js) controlling which MCP tools it can reach.

// High-entropy 256-bit random secret, not a human password — no bcrypt
// here, its deliberate slowness would only add latency to every MCP call
// for no security benefit against a token nobody can guess or brute-force.
function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 8) };
}

// `createdViaTokenId` — the calling MCP token's own id, when this token was
// minted through the `create_api_token` admin tool rather than the self-serve
// session-authed HTTP route (server/routes/mcp-tokens.js, which never passes
// this — a logged-in human isn't "a token creating a token"). See migration
// 056: the only audit trail back to "which token created this one" for a
// tier that can self-replicate access with no human confirming each grant.
export async function createApiToken(siteId, { label = null, createdBy = null, permissionLevel = DEFAULT_PERMISSION_LEVEL, createdViaTokenId = null } = {}) {
  const { raw, hash, prefix } = generateToken();
  const { rows } = await query(
    `INSERT INTO api_tokens (site_id, token_hash, token_prefix, label, created_by, permission_level, created_via_token_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, site_id, token_prefix, label, permission_level, created_via_token_id, created_at`,
    [siteId, hash, prefix, label, createdBy, permissionLevel, createdViaTokenId]
  );
  return { ...rows[0], token: raw }; // raw token present only on this one response — never stored or logged
}

export async function listApiTokensForSite(siteId) {
  const { rows } = await query(
    `SELECT id, token_prefix, label, permission_level, created_via_token_id, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE site_id = $1 ORDER BY created_at DESC`,
    [siteId]
  );
  return rows;
}

export async function revokeApiToken(siteId, id) {
  const { rows } = await query(
    `UPDATE api_tokens SET revoked_at = now()
     WHERE id = $1 AND site_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, siteId]
  );
  return rows.length > 0;
}

// Sole lookup path used by MCP auth — site_id always comes back FROM the
// row, it is never an input here, so a caller can't request another
// site's data by passing a site id alongside a token.
export async function findActiveTokenByRawValue(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `SELECT id, site_id, permission_level FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash]
  );
  return rows[0] || null;
}

export async function touchApiTokenLastUsed(id) {
  await query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [id]);
}
