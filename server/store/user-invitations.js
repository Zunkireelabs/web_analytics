import crypto from 'node:crypto';
import { query } from '../db.js';

// PLATFORM-ADMIN-DESIGN.md §E — same token shape as api_tokens/oauth
// tokens: high-entropy random value, only its SHA-256 hash ever stored, raw
// value returned exactly once (to the route that emails it) and never
// logged or persisted anywhere else.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateInvitationToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// site_id/role/invitedBy are exactly what the calling route already derived
// server-side from the inviter's own identity (§E) — this function trusts
// them as given, it does not re-derive or validate them itself.
export async function createInvitation({ siteId, email, role, invitedBy }) {
  const { raw, hash } = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO user_invitations (site_id, email, role, invited_by, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, site_id, email, role, expires_at`,
    [siteId, email, role, invitedBy, hash, expiresAt]
  );
  return { ...rows[0], token: raw };
}

// Single atomic statement validates AND consumes in one round trip — same
// TOCTOU-safe shape as signup_requests' markSignupRequestReviewed guard
// (`WHERE status = 'pending'`) and Phase 3's suspendSite/reactivateSite/
// softDeleteSite. Rejects an unknown token, an already-accepted token
// (replay), and an expired token all in the same WHERE clause — the caller
// gets one null for "no good," never has to ask why separately.
export async function acceptInvitation(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `UPDATE user_invitations SET accepted_at = now()
     WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
     RETURNING id, site_id, email, role`,
    [hash]
  );
  return rows[0] || null;
}
