import { query } from '../db.js';

// What each keyword-discovery path last did for a project, and why it found nothing when it found nothing (migration 274). One row per
// (project, path), replaced on every attempt, always keyed by site_id.
export const DISCOVERY_PATHS = ['dataforseo_demand', 'own_search_queries', 'worker_research'];
const STATUSES = new Set(['ok', 'nothing_new', 'blocked', 'skipped']);

export async function recordDiscoveryStatus(siteId, path, { status, code = null, message, details = {}, keywords = 0 }, { run = query } = {}) {
  if (!STATUSES.has(status)) throw new Error(`unknown discovery status "${status}"`);
  if (!message) throw new Error('a discovery status needs a message a person can act on');
  await run(
    `INSERT INTO keyword_discovery_status (site_id, path, status, reason_code, message, details, keywords, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
     ON CONFLICT (site_id, path) DO UPDATE SET status = EXCLUDED.status, reason_code = EXCLUDED.reason_code, message = EXCLUDED.message,
       details = EXCLUDED.details, keywords = EXCLUDED.keywords, checked_at = now()`,
    [siteId, path, status, code, message, JSON.stringify(details), keywords]
  );
}

/** All projects' latest discovery results (platform view), or one project's when siteId is given. */
export async function listDiscoveryStatus(siteId = null, { run = query } = {}) {
  const { rows } = await run(
    `SELECT s.site_id, st.name AS site_name, s.path, s.status, s.reason_code, s.message, s.details, s.keywords, s.checked_at
       FROM keyword_discovery_status s JOIN sites st ON st.id = s.site_id
      WHERE ($1::int IS NULL OR s.site_id = $1) ORDER BY s.site_id, s.path`, [siteId]);
  return rows;
}
