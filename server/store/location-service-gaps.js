import { query } from '../db.js';

// Persistence for agents/lib/location-service-gap.js's evidence decisions —
// see migration 158 for why this is cached rather than recomputed every
// pass (DataForSEO cost + dead-lettering a refused gap instead of retrying
// it every run).

const RECHECK_COOLDOWN_DAYS = 30; // same cadence as keyword-demand.js's monthly real-volume recheck — real demand doesn't meaningfully shift week to week

export async function getCachedGapEvaluation(siteId, dataFile, locationId, serviceId) {
  const { rows } = await query(
    `SELECT * FROM location_service_gap_evaluations
      WHERE site_id = $1 AND data_file = $2 AND location_id = $3 AND service_id = $4
        AND evaluated_at > now() - ($5 || ' days')::interval`,
    [siteId, dataFile, locationId, serviceId, RECHECK_COOLDOWN_DAYS]
  );
  return rows[0] || null;
}

export async function saveGapEvaluation(siteId, dataFile, locationId, serviceId, { verdict, reason, evidence }) {
  const { rows } = await query(
    `INSERT INTO location_service_gap_evaluations (site_id, data_file, location_id, service_id, verdict, reason, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, data_file, location_id, service_id)
     DO UPDATE SET verdict = $5, reason = $6, evidence = $7, evaluated_at = now()
     RETURNING *`,
    [siteId, dataFile, locationId, serviceId, verdict, reason, evidence ? JSON.stringify(evidence) : null]
  );
  return rows[0];
}
