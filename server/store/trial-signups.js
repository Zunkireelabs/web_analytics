import { query } from '../db.js';
import { getOrCreateProductId, getProductIdBySiteId } from './products.js';

// Keyed on products.id (167_products_table), same reasoning as prospects.js:
// a trial signup belongs to the product's own growth-mode identity, never to
// site_id directly. Every function here still takes siteId — the resolution
// to product_id is entirely internal to this module.

const SELECT_COLUMNS = `
  id, email, company_name AS "companyName", company_domain AS "companyDomain",
  source, classification, classification_evidence AS "classificationEvidence", created_at AS "createdAt"
`;

export async function createTrialSignup(siteId, { email, companyName, companyDomain, source }) {
  const productId = await getOrCreateProductId(siteId);
  const { rows } = await query(
    `INSERT INTO trial_signups (product_id, email, company_name, company_domain, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT_COLUMNS}`,
    [productId, email || null, companyName || null, companyDomain || null, source || null]
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
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return [];
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM trial_signups WHERE product_id = $1 ORDER BY created_at DESC`,
    [productId]
  );
  return rows;
}
