import { query } from '../db.js';

// Per-page technical SEO check results (migration 026) — the rotation
// bookkeeping + latest snapshot for server/agents/technical-seo.js.

// checked_at per candidate page, keyed by page — pages with no row at all
// (never checked) are simply absent from the returned Map; the caller
// (agents/lib/candidate-pages.js's selectCandidatePages, via an adapter in
// technical-seo.js) treats an absent entry the same as NULL (never checked,
// sorts first), since there's no reason to pre-insert a placeholder row
// just to have something to ORDER BY.
export async function getCheckedAtForPages(siteId, pages) {
  if (!pages.length) return new Map();
  const { rows } = await query(
    'SELECT page, checked_at FROM technical_seo_checks WHERE site_id = $1 AND page = ANY($2)',
    [siteId, pages]
  );
  return new Map(rows.map((r) => [r.page, r.checked_at]));
}

export async function upsertTechnicalSeoCheck(siteId, page, { indexStatus, coreWebVitals, technicalAudit, brokenLinks, lastImpressions }) {
  const { rows } = await query(
    `INSERT INTO technical_seo_checks (site_id, page, checked_at, index_status, core_web_vitals, technical_audit, broken_links, last_impressions)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, page) DO UPDATE SET
       checked_at = now(), index_status = EXCLUDED.index_status, core_web_vitals = EXCLUDED.core_web_vitals,
       technical_audit = EXCLUDED.technical_audit, broken_links = EXCLUDED.broken_links, last_impressions = EXCLUDED.last_impressions
     RETURNING *`,
    [
      siteId, page,
      indexStatus ? JSON.stringify(indexStatus) : null,
      coreWebVitals ? JSON.stringify(coreWebVitals) : null,
      technicalAudit ? JSON.stringify(technicalAudit) : null,
      brokenLinks ? JSON.stringify(brokenLinks) : null,
      lastImpressions ?? null,
    ]
  );
  return rows[0];
}

// Real title + page for every page ever checked on this site — the site-wide
// (not just today's rotation batch) half of duplicate-title detection. Cheap:
// one query against a table that already exists, not a new fetch/API call.
export async function listTitlesForSite(siteId) {
  const { rows } = await query(
    `SELECT page, technical_audit->>'title' AS title, last_impressions
       FROM technical_seo_checks
      WHERE site_id = $1 AND technical_audit->>'title' IS NOT NULL AND technical_audit->>'title' != ''`,
    [siteId]
  );
  return rows;
}
