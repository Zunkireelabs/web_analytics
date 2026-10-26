import { createHash, randomBytes } from 'node:crypto';
import { query, pool } from '../db.js';

// signup_requests (migration 037) — a real prospective-client submission
// that only becomes a real sites/users row once staff approves it (see
// server/routes/clients.js's approve/reject routes).

export async function createSignupRequest({ companyName, websiteDomain, contactEmail, passwordHash, message }) {
  const { rows } = await query(
    `INSERT INTO signup_requests (company_name, website_domain, contact_email, password_hash, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [companyName, websiteDomain || null, contactEmail, passwordHash, message || null]
  );
  return rows[0];
}

export async function listPendingSignupRequests() {
  const { rows } = await query(
    `SELECT * FROM signup_requests WHERE status = 'pending' ORDER BY created_at ASC`
  );
  return rows;
}

export async function getSignupRequestById(id) {
  const { rows } = await query('SELECT * FROM signup_requests WHERE id = $1', [id]);
  return rows[0] || null;
}

// status: 'approved' | 'rejected'. createdSiteId only set on approval.
// Guarded on WHERE status='pending' — an atomic claim, not a check-then-act:
// closes the real race where two staff reviewing the same request within
// milliseconds of each other could otherwise both pass an earlier read-only
// status check and (for approve) each create a full duplicate site. Only
// the first caller gets a row back; a second call returns null.
export async function markSignupRequestReviewed(id, status, createdSiteId = null) {
  const { rows } = await query(
    `UPDATE signup_requests SET status = $2, created_site_id = $3, reviewed_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, createdSiteId]
  );
  return rows[0] || null;
}

// Attaches the real site id after it's actually been created — called only
// once the approve route's site+user creation has succeeded, since the
// claim above (which flips status to 'approved') deliberately happens
// before that, to close the race.
export async function setSignupRequestCreatedSite(id, createdSiteId) {
  await query('UPDATE signup_requests SET created_site_id = $2 WHERE id = $1', [id, createdSiteId]);
}

// ───────── email verification (migration 201) ─────────

const VERIFY_DAYS = 7;
export const hashVerifyToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// Requests staff have approved whose owner has not confirmed their email yet: staff can
// resend the link for these. (Pending requests are listed by listPendingSignupRequests.)
export async function listAwaitingVerification() {
  // Only requests that really are waiting: approved BEFORE migration 201 (when approving created
  // the login at once) means the account already exists, and those must never look "waiting".
  const { rows } = await query(
    `SELECT * FROM signup_requests s
      WHERE s.status = 'approved' AND s.verified_at IS NULL AND s.user_id IS NULL AND s.created_site_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = s.contact_email)
      ORDER BY s.reviewed_at ASC`);
  return rows;
}

// Mints a fresh one-time token for an approved, not-yet-verified request and stores only its
// hash. Calling it again REPLACES the token, so an old link stops working the moment a new
// one is sent. Returns the raw token (this is the only moment it exists) or null if the
// request is not in a state that can be verified.
export async function issueVerificationToken(requestId) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await query(
    `UPDATE signup_requests
        SET verify_token_hash = $2, verify_expires_at = now() + ($3 || ' days')::interval
      WHERE id = $1 AND status = 'approved' AND verified_at IS NULL AND user_id IS NULL AND created_site_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = signup_requests.contact_email)
      RETURNING id`,
    [requestId, hashVerifyToken(token), String(VERIFY_DAYS)]);
  return rows[0] ? token : null;
}

// Looks a token up WITHOUT using it, for the page that asks "confirm your email?" so it can
// say whose account it is, or that the link has expired, before anything is created.
export async function peekVerificationToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT id, company_name, contact_email, verify_expires_at
       FROM signup_requests
      WHERE verify_token_hash = $1 AND status = 'approved' AND verified_at IS NULL`,
    [hashVerifyToken(token)]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, companyName: r.company_name, email: r.contact_email, expired: new Date(r.verify_expires_at) <= new Date() };
}

// Uses the token: in ONE transaction, claim the request (single use: verified_at is set only if
// it was still null and the link has not expired) and create the login from the password hash
// stored at sign-up. Either both happen or neither, so a failure cannot leave a used link with
// no account behind. Returns { ok:true, user } or { ok:false, reason }.
export async function consumeVerificationToken(token) {
  if (!token) return { ok: false, reason: 'invalid' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE signup_requests SET verified_at = now(), verify_token_hash = NULL
        WHERE verify_token_hash = $1 AND status = 'approved' AND verified_at IS NULL AND verify_expires_at > now()
        RETURNING id, company_name, contact_email, password_hash`,
      [hashVerifyToken(token)]);
    const req = rows[0];
    if (!req) { await client.query('ROLLBACK'); return { ok: false, reason: 'invalid' }; }

    const taken = await client.query('SELECT 1 FROM users WHERE email = $1', [req.contact_email]);
    if (taken.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'exists' }; }

    // site_id NULL: a login with no project yet (migration 198). They create their own.
    const created = await client.query(
      `INSERT INTO users (site_id, email, password_hash, role) VALUES (NULL, $1, $2, 'tenant_admin') RETURNING id, email`,
      [req.contact_email, req.password_hash]);
    await client.query('UPDATE signup_requests SET user_id = $2 WHERE id = $1', [req.id, created.rows[0].id]);
    await client.query('COMMIT');
    return { ok: true, user: created.rows[0], companyName: req.company_name, requestId: req.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
