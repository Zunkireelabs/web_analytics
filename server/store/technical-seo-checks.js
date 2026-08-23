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

// Prioritizes a page for its next technical-seo rotation batch by resetting
// it to "never checked" — sortByRotation (agents/lib/rotation.js) already
// treats an absent/null checked_at as highest priority, sorting it first.
// Reuses that existing bounded-rotation mechanism instead of firing a new
// synchronous inspectUrl() call per merge, which would risk exhausting the
// shared, quota-limited Search Console credential across every tenant on
// the platform (see gsc-technical.js's inspectUrl doc comment) — especially
// once more clients are connected, which is the whole point of this being
// generic. A real, automatic recheck still happens, just on
// technical-seo's next scheduled run rather than instantly.
export async function prioritizeForRecheck(siteId, page) {
  await query('UPDATE technical_seo_checks SET checked_at = NULL WHERE site_id = $1 AND page = $2', [siteId, page]);
}

export async function upsertTechnicalSeoCheck(siteId, page, {
  indexStatus, coreWebVitals, technicalAudit, brokenLinks, lastImpressions,
  wordCount, metaDescription, internalLinkCount,
}) {
  const { rows } = await query(
    `INSERT INTO technical_seo_checks (site_id, page, checked_at, index_status, core_web_vitals, technical_audit, broken_links, last_impressions, word_count, meta_description, internal_link_count)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (site_id, page) DO UPDATE SET
       checked_at = now(), index_status = EXCLUDED.index_status, core_web_vitals = EXCLUDED.core_web_vitals,
       technical_audit = EXCLUDED.technical_audit, broken_links = EXCLUDED.broken_links, last_impressions = EXCLUDED.last_impressions,
       word_count = EXCLUDED.word_count, meta_description = EXCLUDED.meta_description, internal_link_count = EXCLUDED.internal_link_count
     RETURNING *`,
    [
      siteId, page,
      indexStatus ? JSON.stringify(indexStatus) : null,
      coreWebVitals ? JSON.stringify(coreWebVitals) : null,
      technicalAudit ? JSON.stringify(technicalAudit) : null,
      brokenLinks ? JSON.stringify(brokenLinks) : null,
      lastImpressions ?? null,
      wordCount ?? null,
      metaDescription || null,
      internalLinkCount ?? null,
    ]
  );
  return rows[0];
}

// Read-only content + technical signal slice for MCP's get_technical_seo_signals
// — every field here is either an already-persisted column or a value already
// nested in technical_audit's JSONB (flattened out for a simpler tool result).
// Absent/never-checked pages are simply omitted, same convention as
// getCheckedAtForPages above.
export async function getTechnicalSeoSignalsForPages(siteId, { pages, limit } = {}) {
  const conditions = ['site_id = $1'];
  const params = [siteId];
  if (pages?.length) {
    params.push(pages);
    conditions.push(`page = ANY($${params.length})`);
  }
  let sql = `SELECT page, checked_at,
                    technical_audit->>'title' AS title,
                    (technical_audit->>'hasCanonical')::boolean AS has_canonical,
                    (technical_audit->>'hasSchema')::boolean AS has_schema,
                    technical_audit->'schemaTypes' AS schema_types,
                    index_status, broken_links, last_impressions,
                    word_count, meta_description, internal_link_count
               FROM technical_seo_checks
              WHERE ${conditions.join(' AND ')}
              ORDER BY checked_at DESC NULLS LAST`;
  if (limit) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows;
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
