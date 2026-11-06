import { query } from '../db.js';

// The deliberate keyword list behind rank tracking (migration 237). Snapshots are NOT here: they go to
// `competitor_rankings`, which already stores one row per (site, date, query, domain) with position and
// is_own_domain, and already has history reads. This file owns only "which keywords are we watching, and may we add
// another".
//
// Every function takes the siteId and puts it in the WHERE clause.

/**
 * Start watching one keyword.
 *
 * The per-site ceiling is enforced HERE, in the INSERT, not by the caller: a cap checked in application code is a cap
 * that the next caller forgets. `sites.rank_tracking_max_keywords` is read in the same statement that inserts, so two
 * concurrent adds cannot both squeeze past it.
 *
 * Returns { added: true, keyword } or { added: false, reason: 'cap_reached' | 'already_tracked' }.
 */
export async function addTrackedKeyword(siteId, keyword, { locationCode, languageCode = 'en', source, gapId = null } = {}) {
  const text = normalizeKeyword(keyword);
  if (!text) return { added: false, reason: 'invalid_keyword' };
  if (!locationCode) return { added: false, reason: 'no_location' };

  const { rows } = await query(
    `INSERT INTO tracked_keywords (site_id, keyword, location_code, language_code, source, gap_id)
     SELECT $1, $2, $3, $4, $5, $6
       FROM sites s
      WHERE s.id = $1
        AND (SELECT count(*) FROM tracked_keywords t WHERE t.site_id = $1 AND t.active) < s.rank_tracking_max_keywords
     ON CONFLICT (site_id, keyword, location_code) DO NOTHING
     RETURNING id, keyword`,
    [siteId, text, locationCode, languageCode, source, gapId]
  );
  if (rows[0]) return { added: true, keyword: rows[0].keyword, id: rows[0].id };

  // Nothing inserted: either the keyword is already there, or the ceiling stopped it. Distinguished so a caller can
  // report the real reason instead of a bare failure.
  const { rows: existing } = await query(
    'SELECT id, active FROM tracked_keywords WHERE site_id = $1 AND keyword = $2 AND location_code = $3',
    [siteId, text, locationCode]
  );
  if (existing[0]) return { added: false, reason: 'already_tracked', id: existing[0].id, active: existing[0].active };
  return { added: false, reason: 'cap_reached' };
}

// Paused rather than deleted: the keyword stops costing anything, and its position history in competitor_rankings
// stays readable. Un-pausing is the same call with active = true, and goes through the cap again.
export async function setTrackedKeywordActive(siteId, id, active) {
  if (active) {
    const { rows } = await query(
      `UPDATE tracked_keywords t SET active = true
        WHERE t.site_id = $1 AND t.id = $2 AND t.active = false
          AND (SELECT count(*) FROM tracked_keywords x WHERE x.site_id = $1 AND x.active)
              < (SELECT rank_tracking_max_keywords FROM sites WHERE id = $1)
        RETURNING id, active`,
      [siteId, id]
    );
    return rows[0] || null; // null = already active, or the ceiling is full
  }
  const { rows } = await query(
    'UPDATE tracked_keywords SET active = false WHERE site_id = $1 AND id = $2 RETURNING id, active',
    [siteId, id]
  );
  return rows[0] || null;
}

/**
 * The keywords one check run may look at, longest-unchecked first and never more than `limit`.
 *
 * The ordering is what makes a capped run fair: with 25 tracked and a limit of 10, three runs cover all of them
 * rather than re-checking the same first ten forever.
 */
export async function listKeywordsToCheck(siteId, { limit = 25 } = {}) {
  const { rows } = await query(
    `SELECT t.id, t.keyword, t.location_code, t.language_code, t.source, t.last_checked_at
       FROM tracked_keywords t
       JOIN sites s ON s.id = t.site_id
      WHERE t.site_id = $1 AND t.active = true
      ORDER BY t.last_checked_at ASC NULLS FIRST, t.id
      LIMIT LEAST($2::int, (SELECT rank_tracking_max_keywords FROM sites WHERE id = $1))`,
    [siteId, Math.min(Math.max(Number(limit) || 25, 1), 500)]
  );
  return rows;
}

export async function listTrackedKeywords(siteId, { includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT id, keyword, location_code, language_code, source, active, gap_id, added_at, last_checked_at
       FROM tracked_keywords
      WHERE site_id = $1 AND ($2::boolean OR active = true)
      ORDER BY active DESC, keyword`,
    [siteId, includeInactive]
  );
  return rows;
}

export async function markKeywordsChecked(siteId, ids) {
  if (!ids.length) return 0;
  const { rowCount } = await query(
    'UPDATE tracked_keywords SET last_checked_at = now() WHERE site_id = $1 AND id = ANY($2::int[])',
    [siteId, ids]
  );
  return rowCount;
}

export async function trackedKeywordCapacity(siteId) {
  const { rows } = await query(
    `SELECT s.rank_tracking_max_keywords AS max,
            (SELECT count(*)::int FROM tracked_keywords t WHERE t.site_id = s.id AND t.active) AS used
       FROM sites s WHERE s.id = $1`,
    [siteId]
  );
  if (!rows[0]) return null;
  return { max: rows[0].max, used: rows[0].used, remaining: Math.max(0, rows[0].max - rows[0].used) };
}

/**
 * Our own position history for one tracked keyword, newest first — read from competitor_rankings, which is where the
 * snapshots live. Only our own domain's rows: the rest of the SERP is there too and is read elsewhere.
 */
export async function getOwnRankHistory(siteId, keyword, { limit = 52 } = {}) {
  const { rows } = await query(
    `SELECT date, position, url
       FROM competitor_rankings
      WHERE site_id = $1 AND query = $2 AND is_own_domain = true
      ORDER BY date DESC
      LIMIT $3`,
    [siteId, normalizeKeyword(keyword), Math.min(Math.max(Number(limit) || 52, 1), 520)]
  );
  return rows;
}

/**
 * Every tracked keyword with its latest own position and the change since the previous check — the "are we moving"
 * read. A keyword we do not rank for comes back with position null, which is a real answer and must not be shown as
 * position 0 or as a missing row.
 */
export async function getTrackedRankMovement(siteId) {
  const { rows } = await query(
    `WITH own AS (
       SELECT query, date, position,
              ROW_NUMBER() OVER (PARTITION BY query ORDER BY date DESC) AS rn
         FROM competitor_rankings
        WHERE site_id = $1 AND is_own_domain = true
     )
     SELECT t.id, t.keyword, t.location_code, t.active, t.last_checked_at,
            cur.position AS current_position, cur.date AS current_date,
            prev.position AS previous_position, prev.date AS previous_date,
            -- Lower is better, so improvement is previous minus current. Null whenever either side is missing: a
            -- first-ever check has nothing to compare against, which is not the same as "no movement".
            CASE WHEN cur.position IS NOT NULL AND prev.position IS NOT NULL
                 THEN prev.position - cur.position END AS improvement
       FROM tracked_keywords t
       LEFT JOIN own cur  ON cur.query  = t.keyword AND cur.rn  = 1
       LEFT JOIN own prev ON prev.query = t.keyword AND prev.rn = 2
      WHERE t.site_id = $1
      ORDER BY t.active DESC, cur.position ASC NULLS LAST, t.keyword`,
    [siteId]
  );
  return rows;
}

function normalizeKeyword(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return s && s.length <= 200 ? s : null;
}
