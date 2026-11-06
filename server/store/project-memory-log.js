import { query } from '../db.js';

// Persistence for the project-memory version log (migration 226). Every function takes the siteId and puts it in the
// WHERE clause: nothing here can read or write another project's rows.

export async function getLatestMemoryVersion(siteId, section) {
  const { rows } = await query(
    `SELECT version, content_hash, created_at
       FROM project_memory_log
      WHERE site_id = $1 AND section = $2
      ORDER BY version DESC LIMIT 1`,
    [siteId, section]
  );
  return rows[0] || null;
}

// Writes the next version for (site, section). The version number is computed inside the INSERT and the table's
// UNIQUE (site_id, section, version) turns a race between two writers into "the loser inserts nothing" instead of two
// rows with the same number. Returns the new row, or null when another writer got there first.
export async function insertMemoryVersion(siteId, section, { contentHash, digest = {}, provenance = {}, reason = 'manual' }) {
  const { rows } = await query(
    `INSERT INTO project_memory_log (site_id, section, version, content_hash, digest, provenance, reason)
     SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4::jsonb, $5::jsonb, $6
       FROM project_memory_log WHERE site_id = $1 AND section = $2
     ON CONFLICT (site_id, section, version) DO NOTHING
     RETURNING id, site_id, section, version, content_hash, created_at`,
    [siteId, section, contentHash, JSON.stringify(digest), JSON.stringify(provenance), reason]
  );
  return rows[0] || null;
}

export async function listMemoryVersions(siteId, { section = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, section, version, content_hash, digest, provenance, reason, created_at
       FROM project_memory_log
      WHERE site_id = $1 AND ($2::text IS NULL OR section = $2)
      ORDER BY created_at DESC, version DESC
      LIMIT $3`,
    [siteId, section, Math.min(Math.max(Number(limit) || 50, 1), 500)]
  );
  return rows;
}

// How the project's keyword backlog stands, by review status. The one project-memory fact that had no reader of its
// own; a count only, never the topics themselves.
export async function keywordGapSummary(siteId) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n, MAX(created_at) AS latest
       FROM keyword_gaps WHERE site_id = $1 GROUP BY status`,
    [siteId]
  );
  return rows;
}
