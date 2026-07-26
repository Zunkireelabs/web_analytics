import { query } from '../../db.js';

// Lives under server/store/admin/, physically separate from the tenant-
// scoped equivalent (server/store/api-tokens.js's listApiTokensForSite) —
// same import-path-signals-no-tenant-filter guardrail as audit-log.js and
// users.js in this directory (PLATFORM-ADMIN-DESIGN.md §G.2). Metadata
// only — never token_hash or any raw token value, same column list as
// listApiTokensForSite, just without the site_id filter and with the
// tenant's name joined in so the result is readable without a second
// round trip per row.
export async function listAllApiTokensAcrossSites() {
  const { rows } = await query(
    `SELECT t.id, t.site_id, s.name AS site_name, t.token_prefix, t.label, t.permission_level,
            t.created_via_token_id, t.created_at, t.last_used_at, t.revoked_at
       FROM api_tokens t
       JOIN sites s ON s.id = t.site_id
      ORDER BY t.site_id, t.created_at DESC`
  );
  return rows;
}

// The one piece a cross-tenant revoke needs before it can call the existing
// revokeApiToken(siteId, id) — that function's WHERE id = $1 AND site_id =
// $2 predicate (api-tokens.js) is the actual defense-in-depth, this just
// looks up which site_id to pass since the platform caller's own req.siteId
// (always COMPANY_SITE_ID) is never the right value here.
export async function getApiTokenSiteId(id) {
  const { rows } = await query(`SELECT site_id FROM api_tokens WHERE id = $1`, [id]);
  return rows[0]?.site_id ?? null;
}
