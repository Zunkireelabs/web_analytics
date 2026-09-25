import { query } from '../db.js';
import { getOrCreateProductId, getProductIdBySiteId } from './products.js';

// One row per real, evidence-backed prospect (168_prospects_and_crm_handoff.sql),
// keyed on products.id (167_products_table) — a prospect belongs to the
// product's own growth-mode identity, never to site_id directly. A
// discovery run that can't back a candidate with real evidence writes no
// row at all — see server/agents/prospect-discovery.js.
//
// Every function here still takes siteId, not productId: every caller
// (routes/demand.js, routes/crm-webhook.js, agents/prospect-discovery.js)
// only ever knows the site it's acting on — the site_id -> product_id
// resolution is entirely internal to this module.

const SELECT_COLUMNS = `
  id, company_name AS "companyName", market, industry,
  qualification_reason AS "qualificationReason", evidence_json AS evidence,
  confidence, recommended_segment AS "recommendedSegment", status,
  approved_for_crm AS "approvedForCrm", approved_at AS "approvedAt",
  crm_synced_at AS "crmSyncedAt", external_crm_id AS "externalCrmId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ON CONFLICT DO NOTHING against the (product_id, company_name) unique
// index — a re-run of discovery for the same product never overwrites or
// duplicates an existing prospect (which may already carry real staff/CRM
// state), it just skips a company already on record. Returns null when
// skipped.
export async function createProspect(siteId, { companyName, market, industry, qualificationReason, evidence, confidence, recommendedSegment }) {
  const productId = await getOrCreateProductId(siteId);
  const { rows } = await query(
    `INSERT INTO prospects (product_id, company_name, market, industry, qualification_reason, evidence_json, confidence, recommended_segment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (product_id, company_name) WHERE company_name IS NOT NULL DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [productId, companyName, market || null, industry || null, qualificationReason, JSON.stringify(evidence), confidence || 'medium', recommendedSegment || null]
  );
  return rows[0] || null;
}

export async function listProspects(siteId, { status, approvedForCrm } = {}) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return [];

  const conditions = ['product_id = $1'];
  const values = [productId];
  if (status !== undefined) { values.push(status); conditions.push(`status = $${values.length}`); }
  if (approvedForCrm !== undefined) { values.push(approvedForCrm); conditions.push(`approved_for_crm = $${values.length}`); }

  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM prospects WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function getProspectById(siteId, id) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return null;
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM prospects WHERE product_id = $1 AND id = $2`, [productId, id]);
  return rows[0] || null;
}

// Human-approval gate (spec: never auto-send a new prospect segment) — the
// only way a prospect becomes eligible for the CRM export pull
// (server/routes/crm-webhook.js). Product-scoped so one tenant can never
// approve another's prospect via a guessed id.
export async function approveProspectForCrm(siteId, id) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return null;
  const { rows } = await query(
    `UPDATE prospects SET approved_for_crm = true, approved_at = now(), updated_at = now()
      WHERE product_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
    [productId, id]
  );
  return rows[0] || null;
}

// Called once the CRM export endpoint has actually returned this row.
export async function markProspectsCrmSynced(siteId, ids) {
  if (!ids.length) return;
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return;
  await query(
    `UPDATE prospects SET crm_synced_at = now(), updated_at = now() WHERE product_id = $1 AND id = ANY($2::int[])`,
    [productId, ids]
  );
}

// status/externalCrmId come from a real inbound CRM webhook call — see
// server/routes/crm-webhook.js. The CRM's own lifecycle vocabulary is
// trusted as-is (free text, never re-validated against a fixed enum), same
// reasoning 168's migration comment gives for keeping `status` unconstrained.
// The CRM-outcome feedback loop (Product Growth spec §7): real converted
// prospects, grouped by the same (industry, matched ICP signal) pair
// prospect-discovery.js itself qualified them under — evidence for future
// discovery runs to weight toward, never a silent behavior change. A
// product with no converted prospects yet returns an empty array; prospect-
// discovery.js falls back to its normal unweighted order, it never
// fabricates a preference.
export async function getConversionEvidence(siteId) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return [];

  const { rows } = await query(
    `SELECT industry, evidence_json->>'matchedSignal' AS matched_signal, COUNT(*) AS converted_count
       FROM prospects
      WHERE product_id = $1 AND status = 'converted' AND industry IS NOT NULL
      GROUP BY industry, evidence_json->>'matchedSignal'
      ORDER BY converted_count DESC`,
    [productId]
  );
  return rows.map((r) => ({ industry: r.industry, matchedSignal: r.matched_signal, convertedCount: Number(r.converted_count) }));
}

export async function applyCrmOutcome(siteId, { externalCrmId, prospectId, status }) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return null;
  const { rows } = await query(
    `UPDATE prospects SET status = $1, external_crm_id = COALESCE(external_crm_id, $2), updated_at = now()
      WHERE product_id = $3 AND (id = $4 OR external_crm_id = $2)
      RETURNING ${SELECT_COLUMNS}`,
    [status, externalCrmId || null, productId, prospectId || null]
  );
  return rows[0] || null;
}
