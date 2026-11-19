import crypto from 'node:crypto';
import { query, pool } from '../db.js';
import { applyDailyPathCap, DEFAULT_MAX_PATHS_PER_DAY } from '../ai-crawlers/aggregate.js';

// Storage for AI crawler analytics (migration 250). Every function that touches a project's counts takes the siteId as its
// first argument and puts it in the WHERE or the key: there is no function here that reads or writes across projects.
// The siteId for an upload comes from findActiveCrawlerToken(), i.e. from the credential, never from the request body.

export const RETENTION_MONTHS = 13;

// ───────── upload tokens ─────────
// A 256-bit random secret, hashed with SHA-256 (not bcrypt): it is not a human password, and a slow hash would only add latency
// to every hourly upload. Only the hash is stored; the raw token exists on the one response that creates it.
const hashOf = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export async function createCrawlerToken(siteId, { label = null } = {}) {
  const raw = `acr_${crypto.randomBytes(32).toString('hex')}`;
  const { rows } = await query(
    `INSERT INTO ai_crawler_tokens (site_id, token_hash, token_prefix, label)
     VALUES ($1, $2, $3, $4) RETURNING id, site_id, token_prefix, label, created_at`,
    [siteId, hashOf(raw), raw.slice(0, 12), label]
  );
  return { ...rows[0], token: raw };
}

/** The only lookup the upload endpoint uses. site_id comes back FROM the row; it is never an input. */
export async function findActiveCrawlerToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  const { rows } = await query(
    `SELECT id, site_id FROM ai_crawler_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashOf(rawToken)]
  );
  return rows[0] || null;
}

export async function touchCrawlerToken(id) {
  await query(`UPDATE ai_crawler_tokens SET last_used_at = now() WHERE id = $1`, [id]);
}

export async function listCrawlerTokens(siteId) {
  const { rows } = await query(
    `SELECT id, token_prefix, label, created_at, last_used_at, revoked_at
       FROM ai_crawler_tokens WHERE site_id = $1 ORDER BY created_at DESC`,
    [siteId]
  );
  return rows;
}

export async function revokeCrawlerToken(siteId, id) {
  const { rows } = await query(
    `UPDATE ai_crawler_tokens SET revoked_at = now() WHERE id = $1 AND site_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, siteId]
  );
  return rows.length > 0;
}

// ───────── counts ─────────

/**
 * Add one uploaded batch to a project's daily counts. One transaction: the batch record and its counts land together or not
 * at all, so a failure half way can never leave a batch marked "received" with only some of its counts.
 *
 * The batch is identified by `batchHash` (a hash of its content). The same batch sent again, for example a retry after a
 * timeout, finds its record already there and is ignored: { duplicate: true }, counts unchanged.
 *
 * The per-day distinct-path cap is enforced against what is ALREADY stored for those days, not just this batch, so hourly
 * uploads cannot together exceed it. (Two uploads for one project at the very same moment can overshoot it by a little.)
 */
export async function saveCrawlerBatch(siteId, { batchHash, rows, visits = 0, maxPathsPerDay = DEFAULT_MAX_PATHS_PER_DAY }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      `INSERT INTO ai_crawler_batches (site_id, batch_hash, visits) VALUES ($1, $2, $3)
       ON CONFLICT (site_id, batch_hash) DO NOTHING RETURNING 1`,
      [siteId, batchHash, visits]
    );
    if (fresh.rowCount === 0) {
      await client.query('ROLLBACK');
      return { duplicate: true, rowsWritten: 0 };
    }
    let capped = rows;
    if (rows.length) {
      const days = [...new Set(rows.map((r) => r.day))];
      const existing = await client.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, path FROM ai_crawler_visits_daily
          WHERE site_id = $1 AND day = ANY($2::date[]) GROUP BY day, path`,
        [siteId, days]
      );
      const existingByDay = new Map();
      for (const r of existing.rows) {
        if (!existingByDay.has(r.day)) existingByDay.set(r.day, new Set());
        existingByDay.get(r.day).add(r.path);
      }
      capped = applyDailyPathCap(rows, existingByDay, maxPathsPerDay);
      await client.query(
        `INSERT INTO ai_crawler_visits_daily (site_id, day, bot_id, path, status, verification, hits)
         SELECT $1, t.day, t.bot_id, t.path, t.status, t.verification, t.hits
           FROM unnest($2::date[], $3::text[], $4::text[], $5::smallint[], $6::text[], $7::int[]) AS t(day, bot_id, path, status, verification, hits)
         ON CONFLICT (site_id, day, bot_id, path, status, verification)
           DO UPDATE SET hits = ai_crawler_visits_daily.hits + EXCLUDED.hits`,
        [siteId, capped.map((r) => r.day), capped.map((r) => r.botId), capped.map((r) => r.path),
          capped.map((r) => r.status), capped.map((r) => r.verification), capped.map((r) => r.hits)]
      );
    }
    await client.query('COMMIT');
    return { duplicate: false, rowsWritten: capped.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One project's daily rows for a date range (YYYY-MM-DD, inclusive). Always scoped to the one siteId passed. */
export async function getCrawlerRows(siteId, from, to) {
  const { rows } = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, bot_id AS "botId", path, status, verification, hits
       FROM ai_crawler_visits_daily
      WHERE site_id = $1 AND day BETWEEN $2::date AND $3::date
      ORDER BY day, bot_id, path, status, verification`,
    [siteId, from, to]
  );
  return rows;
}

/** Delete counts older than the retention window (13 months) and batch records older than 14 days. All projects. */
export async function pruneCrawlerData({ months = RETENTION_MONTHS } = {}) {
  const counts = await query(
    `DELETE FROM ai_crawler_visits_daily WHERE day < ((now() AT TIME ZONE 'UTC')::date - make_interval(months => $1))`,
    [months]
  );
  const batches = await query(`DELETE FROM ai_crawler_batches WHERE received_at < now() - interval '14 days'`);
  return { countsDeleted: counts.rowCount, batchesDeleted: batches.rowCount };
}

// ───────── vendor IP list cache ─────────

export async function loadIpListCache() {
  const { rows } = await query(`SELECT list_id, cidrs, creation_time, fetched_at, last_attempt_at, last_error FROM ai_crawler_ip_lists`);
  return rows;
}

/** A successful fetch replaces the list; a failed one records the error and KEEPS the last good list. */
export async function saveIpListResult(listId, result, now = new Date()) {
  if (result.ok) {
    await query(
      `INSERT INTO ai_crawler_ip_lists (list_id, cidrs, creation_time, fetched_at, last_attempt_at, last_error)
       VALUES ($1, $2::jsonb, $3, $4, $4, NULL)
       ON CONFLICT (list_id) DO UPDATE SET cidrs = EXCLUDED.cidrs, creation_time = EXCLUDED.creation_time,
         fetched_at = EXCLUDED.fetched_at, last_attempt_at = EXCLUDED.last_attempt_at, last_error = NULL`,
      [listId, JSON.stringify(result.cidrs), result.creationTime, now]
    );
  } else {
    await query(
      `INSERT INTO ai_crawler_ip_lists (list_id, last_attempt_at, last_error) VALUES ($1, $2, $3)
       ON CONFLICT (list_id) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at, last_error = EXCLUDED.last_error`,
      [listId, now, String(result.error || 'failed').slice(0, 200)]
    );
  }
}

/** Staff only (the route checks): every live project with its upload status. Names and counts, no crawler data. */
export async function listCrawlerSiteStatuses() {
  const { rows } = await query(
    `SELECT s.id, s.name, s.website_domain AS domain,
            (SELECT count(*)::int FROM ai_crawler_tokens t WHERE t.site_id = s.id AND t.revoked_at IS NULL) AS active_tokens,
            (SELECT max(t.last_used_at) FROM ai_crawler_tokens t WHERE t.site_id = s.id AND t.revoked_at IS NULL) AS last_upload_at,
            (SELECT to_char(min(v.day), 'YYYY-MM-DD') FROM ai_crawler_visits_daily v WHERE v.site_id = s.id) AS first_day
       FROM sites s
      WHERE s.status IS DISTINCT FROM 'soft_deleted'
      ORDER BY s.name`
  );
  return rows;
}

/** One project's status for its own page: is the script set up, and when did it last report. */
export async function getCrawlerSiteStatus(siteId) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM ai_crawler_tokens t WHERE t.site_id = $1 AND t.revoked_at IS NULL) AS active_tokens,
            (SELECT max(t.last_used_at) FROM ai_crawler_tokens t WHERE t.site_id = $1 AND t.revoked_at IS NULL) AS last_upload_at,
            (SELECT to_char(min(v.day), 'YYYY-MM-DD') FROM ai_crawler_visits_daily v WHERE v.site_id = $1) AS first_day`,
    [siteId]
  );
  return rows[0];
}
