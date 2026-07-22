import { query } from '../db.js';

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
