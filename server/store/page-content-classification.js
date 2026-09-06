import { query } from '../db.js';

// Cache for page-content-classifier.js's classification (migration 122).
// Strictly scoped by site_id on every read — this table is per-tenant, and
// unlike agent_fix_memory it never becomes a cross-tenant row itself; only
// the resulting content-type STRING is ever read out and pushed into a
// site-fingerprint token by the caller.

export async function getPageContentType(siteId, page) {
  const { rows } = await query(
    `SELECT content_type, confidence, classified_by, classified_at
     FROM page_content_classification WHERE site_id = $1 AND page = $2`,
    [siteId, page]
  );
  return rows[0] || null;
}

export async function upsertPageContentType({ siteId, page, contentType, confidence, classifiedBy }) {
  const { rows } = await query(
    `INSERT INTO page_content_classification (site_id, page, content_type, confidence, classified_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, page) DO UPDATE
       SET content_type = $3, confidence = $4, classified_by = $5, classified_at = now()
     RETURNING content_type, confidence, classified_by, classified_at`,
    [siteId, page, contentType, confidence, classifiedBy]
  );
  return rows[0];
}
