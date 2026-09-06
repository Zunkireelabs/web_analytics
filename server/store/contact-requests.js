import { query } from '../db.js';

// contact_requests (migration 046) — a lightweight "get in touch" lead,
// distinct from signup_requests: no password, never becomes a real
// sites/users row. Reviewed by the sales team through a separate process,
// not this app — this table is only ever written to, never read back here.

export async function createContactRequest({ companyName, websiteDomain, contactEmail, message }) {
  const { rows } = await query(
    `INSERT INTO contact_requests (company_name, website_domain, contact_email, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyName, websiteDomain || null, contactEmail, message || null]
  );
  return rows[0];
}
