import { query } from '../db.js';

// Best-effort: a logging write failing must never take down the ship path
// it's observing (same swallow-and-log convention as job.js's sendDailyEmail).
export async function recordDesignIntegrityVerdict({
  siteId, findingId = null, actionType = null, verdict, enforced,
}) {
  try {
    await query(
      `INSERT INTO design_integrity_verdicts (site_id, finding_id, action_type, ok, reason, field, error_message, enforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, findingId, actionType, verdict.ok, verdict.reason || null, verdict.field || null, verdict.error || null, enforced]
    );
  } catch (err) {
    console.error('[design-integrity-verdicts] failed to record verdict:', err.message);
  }
}
