import { query } from '../../db.js';

// Lives under server/store/admin/, physically separate from the tenant-
// scoped equivalent (server/store/users.js's listUsersForSite) — same
// import-path-signals-no-tenant-filter guardrail as audit-log.js in this
// directory (PLATFORM-ADMIN-DESIGN.md §G.2). Cross-tenant user directory —
// "platform staff list + per-tenant user lists" in one query, joined with
// the site name so the result is actually readable without a second round
// trip per row. Never selects password_hash.
export async function listAllUsers() {
  const { rows } = await query(
    `SELECT u.id, u.site_id, s.name AS site_name, u.email, u.role, u.status, u.last_login_at, u.created_at
     FROM users u
     JOIN sites s ON s.id = u.site_id
     ORDER BY u.site_id, u.id`
  );
  return rows;
}
