import { query } from '../db.js';

// One login per site — see server/migrations/011_users_and_site_profile.sql.

export async function getUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

// role defaults to 'tenant_admin' — matches users.role's own column default
// (062) and keeps every existing caller (clients.js's direct-create and
// signup-request-approve flows, both of which should keep minting
// tenant_admin accounts) behaving exactly as before without having to pass
// it explicitly. Only the Phase 4 invitation-accept flow (server/routes/
// user-invitations.js) passes a real value here, carried over from the
// invitation's own role column.
export async function createUser({ siteId, email, passwordHash, role = 'tenant_admin' }) {
  const { rows } = await query(
    `INSERT INTO users (site_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
    [siteId, email, passwordHash, role]
  );
  return rows[0];
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function updateUserPassword(userId, passwordHash) {
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
}

// Single-column lookup for requireAuth's disabled-user check (PLATFORM-
// ADMIN-DESIGN.md §D/§E's "same mechanism" as the site-status check) —
// same reasoning as read.js's getSiteStatus: this runs on every
// authenticated request, has nothing to do with the rest of the user row.
export async function getUserStatus(id) {
  const { rows } = await query('SELECT status FROM users WHERE id = $1', [id]);
  return rows[0]?.status ?? null;
}

// Own-tenant directory (Team tab, §H — not built until Phase 7, but the
// data layer doesn't need to wait). Never selects password_hash.
export async function listUsersForSite(siteId) {
  const { rows } = await query(
    `SELECT id, email, role, status, last_login_at, created_at
     FROM users WHERE site_id = $1 ORDER BY id`,
    [siteId]
  );
  return rows;
}

export async function updateUserRole(userId, role) {
  const { rows } = await query(
    `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, site_id, email, role, status`,
    [role, userId]
  );
  return rows[0] || null;
}

// Atomic guard mirrors Phase 3's suspendSite/reactivateSite/softDeleteSite:
// the WHERE clause bakes in "only from active," so a caller never needs a
// separate read-then-write check for "was this already disabled."
export async function disableUser(userId) {
  const { rows } = await query(
    `UPDATE users SET status = 'disabled' WHERE id = $1 AND status = 'active' RETURNING id, site_id, email, role, status`,
    [userId]
  );
  return rows[0] || null;
}
