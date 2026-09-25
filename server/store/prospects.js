import { query } from '../db.js';

// One row per real, evidence-backed prospect (168_prospects_and_crm_handoff.sql).
// A discovery run that can't back a candidate with real evidence writes no
// row at all — see server/agents/prospect-discovery.js.

const SELECT_COLUMNS = `
  id, site_id AS "siteId", company_name AS "companyName", market, industry,
  qualification_reason AS "qualificationReason", evidence_json AS evidence,
  confidence, recommended_segment AS "recommendedSegment", status,
  approved_for_crm AS "approvedForCrm", approved_at AS "approvedAt",
  crm_synced_at AS "crmSyncedAt", external_crm_id AS "externalCrmId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ON CONFLICT DO NOTHING against the (site_id, company_name) unique index —
// a re-run of discovery for the same site never overwrites or duplicates an
// existing prospect (which may already carry real staff/CRM state), it just
// skips a company already on record. Returns null when skipped.
export async function createProspect(siteId, { companyName, market, industry, qualificationReason, evidence, confidence, recommendedSegment }) {
  const { rows } = await query(
    `INSERT INTO prospects (site_id, company_name, market, industry, qualification_reason, evidence_json, confidence, recommended_segment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (site_id, company_name) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [siteId, companyName, market || null, industry || null, qualificationReason, JSON.stringify(evidence), confidence || 'medium', recommendedSegment || null]
  );
  return rows[0] || null;
}

export async function listProspects(siteId, { status, approvedForCrm } = {}) {
  const conditions = ['site_id = $1'];
  const values = [siteId];
  if (status !== undefined) { values.push(status); conditions.push(`status = $${values.length}`); }
  if (approvedForCrm !== undefined) { values.push(approvedForCrm); conditions.push(`approved_for_crm = $${values.length}`); }

  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM prospects WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function getProspectById(siteId, id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM prospects WHERE site_id = $1 AND id = $2`, [siteId, id]);
  return rows[0] || null;
}

// Human-approval gate (spec: never auto-send a new prospect segment) — the
// only way a prospect becomes eligible for the CRM export pull
// (server/routes/crm-webhook.js). siteId-scoped so one tenant can never
// approve another's prospect via a guessed id.
export async function approveProspectForCrm(siteId, id) {
  const { rows } = await query(
    `UPDATE prospects SET approved_for_crm = true, approved_at = now(), updated_at = now()
      WHERE site_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
    [siteId, id]
  );
  return rows[0] || null;
}

// Called once the CRM export endpoint has actually returned this row.
export async function markProspectsCrmSynced(siteId, ids) {
  if (!ids.length) return;
  await query(
    `UPDATE prospects SET crm_synced_at = now(), updated_at = now() WHERE site_id = $1 AND id = ANY($2::int[])`,
    [siteId, ids]
  );
}

// status/externalCrmId come from a real inbound CRM webhook call — see
// server/routes/crm-webhook.js. The CRM's own lifecycle vocabulary is
// trusted as-is (free text, never re-validated against a fixed enum), same
// reasoning 168's migration comment gives for keeping `status` unconstrained.
// The CRM-outcome feedback loop (Product Growth spec §7): real converted
// prospects, grouped by the same (industry, matched ICP signal) pair
// prospect-discovery.js itself qualified them under — evidence for future
// discovery runs to weight toward, never a silent behavior change. A site
// with no converted prospects yet returns an empty array; prospect-
// discovery.js falls back to its normal unweighted order, it never
// fabricates a preference.
export async function getConversionEvidence(siteId) {
  const { rows } = await query(
    `SELECT industry, evidence_json->>'matchedSignal' AS matched_signal, COUNT(*) AS converted_count
       FROM prospects
      WHERE site_id = $1 AND status = 'converted' AND industry IS NOT NULL
      GROUP BY industry, evidence_json->>'matchedSignal'
      ORDER BY converted_count DESC`,
    [siteId]
  );
  return rows.map((r) => ({ industry: r.industry, matchedSignal: r.matched_signal, convertedCount: Number(r.converted_count) }));
}

export async function applyCrmOutcome(siteId, { externalCrmId, prospectId, status }) {
  const { rows } = await query(
    `UPDATE prospects SET status = $1, external_crm_id = COALESCE(external_crm_id, $2), updated_at = now()
      WHERE site_id = $3 AND (id = $4 OR external_crm_id = $2)
      RETURNING ${SELECT_COLUMNS}`,
    [status, externalCrmId || null, siteId, prospectId || null]
  );
  return rows[0] || null;
}
