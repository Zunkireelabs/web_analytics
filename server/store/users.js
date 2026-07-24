import { query } from '../db.js';

// One login per site — see server/migrations/011_users_and_site_profile.sql.

export async function getUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

export async function createUser({ siteId, email, passwordHash }) {
  const { rows } = await query(
    `INSERT INTO users (site_id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [siteId, email, passwordHash]
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
