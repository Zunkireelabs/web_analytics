import crypto from 'node:crypto';
import { query } from '../db.js';

// PLATFORM-ADMIN-DESIGN.md §E. Shorter TTL than user_invitations (1 hour vs
// 7 days) — this token grants an immediate password change on an existing,
// real account, a more sensitive action than accepting a first-time invite.
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function generateResetToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function createPasswordReset(userId) {
  const { raw, hash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  const { rows } = await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id, user_id, expires_at`,
    [userId, hash, expiresAt]
  );
  return { ...rows[0], token: raw };
}

// Same atomic validate-and-consume shape as acceptInvitation — one
// statement rejects unknown/already-used/expired tokens together.
export async function consumePasswordReset(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `UPDATE password_resets SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, user_id`,
    [hash]
  );
  return rows[0] || null;
}
