import { query } from '../db.js';

// Audit trail for the Website Capability Discovery and Repair mechanism
// (migration 124) — one row per attempt (autoHealFileMapping's new evidence
// tiers, autoHealNewContentTarget), success or not, so an "ambiguous" or
// "foreign-domain" outcome is as visible to a human as a repaired one.
// Never fatal to the caller: recording the audit row is secondary to the
// repair attempt itself, so a DB hiccup here must not turn a real repair (or
// a real refusal-to-guess) into a thrown error.
export async function recordCapabilityRepair(siteId, { capabilityType, target, outcome, evidenceTier, detail }) {
  try {
    await query(
      `INSERT INTO capability_repairs (site_id, capability_type, target, outcome, evidence_tier, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [siteId, capabilityType, target, outcome, evidenceTier ?? null, JSON.stringify(detail || {})]
    );
  } catch (err) {
    console.warn(`[capability-repairs] site ${siteId}: failed to record ${capabilityType} attempt for ${target}: ${err.message}`);
  }
}

export async function listCapabilityRepairs(siteId, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM capability_repairs WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}
