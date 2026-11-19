import { query } from '../db.js';

// Keeps the last readiness result on the project (migration 257). The result is the COMPACT form (summarizeReadiness): never the plan's file contents.
export async function saveReadinessResult(siteId, result, now = new Date()) {
  await query('UPDATE sites SET readiness_result = $2::jsonb, readiness_at = $3 WHERE id = $1', [siteId, JSON.stringify(result ?? {}), now]);
}
