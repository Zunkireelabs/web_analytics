import { query } from '../db.js';

const SELECT_COLUMNS = `
  id, site_id AS "siteId", email, company_name AS "companyName", company_domain AS "companyDomain",
  source, classification, classification_evidence AS "classificationEvidence", created_at AS "createdAt"
`;

export async function createTrialSignup(siteId, { email, companyName, companyDomain, source }) {
  const { rows } = await query(
    `INSERT INTO trial_signups (site_id, email, company_name, company_domain, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT_COLUMNS}`,
    [siteId, email || null, companyName || null, companyDomain || null, source || null]
  );
  return rows[0];
}

export async function classifyTrialSignup(id, { classification, evidence }) {
  const { rows } = await query(
    `UPDATE trial_signups SET classification = $1, classification_evidence = $2 WHERE id = $3 RETURNING ${SELECT_COLUMNS}`,
    [classification, evidence ? JSON.stringify(evidence) : null, id]
  );
  return rows[0] || null;
}

export async function listTrialSignups(siteId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM trial_signups WHERE site_id = $1 ORDER BY created_at DESC`,
    [siteId]
  );
  return rows;
}
