import { query, pool } from '../db.js';

// Google Analytics "Views by page title" (migration 245): the write for one day and the Overview's range read.

/**
 * Replace ONE day's page list. A re-fetch of a day replaces it rather than adding to it, which is what makes the
 * 7-day rolling re-ingest safe to repeat. The delete and the insert are ONE transaction: a failed insert rolls the
 * delete back (the day keeps its earlier list), and a reader never sees the gap between the two statements.
 * An empty list clears the day (GA4 genuinely returned no pages); callers that did not fetch pages pass nothing.
 */
export async function replaceGa4PagesForDay(siteId, date, pages) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ga4_pages WHERE site_id = $1 AND date = $2', [siteId, date]);
    let written = 0;
    if (pages?.length) {
      const res = await client.query(
        `INSERT INTO ga4_pages (site_id, date, page_title, views, users)
         SELECT $1, $2, t.title, t.views, t.users
           FROM unnest($3::text[], $4::int[], $5::int[]) AS t(title, views, users)
         ON CONFLICT (site_id, date, page_title) DO UPDATE SET views = EXCLUDED.views, users = EXCLUDED.users`,
        [siteId, date, pages.map((p) => p.page_title), pages.map((p) => p.views), pages.map((p) => p.users)]
      );
      written = res.rowCount;
    }
    await client.query('COMMIT');
    return written;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (v) => typeof v === 'string' && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const spanDays = (start, end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;

// Plain-English reading of how much of the period's views the stored lists account for. Null note = nothing to say.
export const PAGES_COVERAGE_OK = 0.98;
export function describePagesQuality(rows) {
  let listed = 0; let total = 0; let thresholdedDays = 0; let otherDays = 0; let assessed = 0;
  for (const r of rows) {
    const q = r.pages;
    if (!q) continue;
    assessed += 1;
    if (Number(q.totalViews) > 0) { total += Number(q.totalViews); listed += Number(q.listedViews) || 0; }
    if (q.thresholded) thresholdedDays += 1;
    if (q.otherRowPresent) otherDays += 1;
  }
  const notes = [];
  const listedShare = total > 0 ? Number(Math.min(listed / total, 1).toFixed(4)) : null;
  if (listedShare != null && listedShare < PAGES_COVERAGE_OK) {
    notes.push(`This list shows the most viewed pages each day. The other ${Math.round((1 - listedShare) * 100)}% of views are spread across pages not listed.`);
  }
  if (thresholdedDays) notes.push(`Google withheld some pages on ${thresholdedDays} ${thresholdedDays === 1 ? 'day' : 'days'} to protect visitor privacy.`);
  if (otherDays) notes.push(`On ${otherDays} ${otherDays === 1 ? 'day' : 'days'} Google grouped the least viewed pages together, so they are not listed.`);
  return {
    // 'unassessed': pages stored before coverage was recorded. Never reported as 'complete'.
    confidence: assessed === 0 ? 'unassessed' : (notes.length ? 'partial' : 'complete'),
    listedShare,
    notes,
  };
}

/**
 * The Overview "Top pages" card: the period's most viewed page titles, each with its views in the comparison period.
 * Views only, never users: a per-day user count summed across days counts a returning person once per day.
 *
 * `compareStart`/`compareEnd` mirror the Overview's compare modes; without them the comparison is the same-length
 * window immediately before `start`. A page absent from the comparison period has prev_views null and change_pct null
 * ("no baseline"), which is not the same as 0 views and is never shown as +infinity.
 */
export async function getTopPages(siteId, { start, end, compareStart, compareEnd, limit = 10 } = {}) {
  const cur = { start, end };
  const prev = (compareStart && compareEnd)
    ? { start: compareStart, end: compareEnd }
    : { start: shiftYmd(start, -spanDays(start, end)), end: shiftYmd(start, -1) };

  const { rows } = await query(
    `WITH cur AS (
       SELECT page_title, SUM(views)::int AS views FROM ga4_pages
        WHERE site_id = $1 AND date BETWEEN $2 AND $3 GROUP BY page_title
        ORDER BY SUM(views) DESC, page_title LIMIT $6
     ), prev AS (
       SELECT page_title, SUM(views)::int AS views FROM ga4_pages
        WHERE site_id = $1 AND date BETWEEN $4 AND $5 GROUP BY page_title
     )
     SELECT cur.page_title, cur.views, prev.views AS prev_views
       FROM cur LEFT JOIN prev USING (page_title)
      ORDER BY cur.views DESC, cur.page_title`,
    [siteId, cur.start, cur.end, prev.start, prev.end, limit]
  );
  const pages = rows.map((r) => ({
    title: r.page_title,
    views: r.views,
    prev_views: r.prev_views ?? null,
    change_pct: r.prev_views ? Math.round(((r.views - r.prev_views) / r.prev_views) * 1000) / 10 : null,
  }));

  const [{ rows: [curDays] }, { rows: [prevDays] }, { rows: quality }] = await Promise.all([
    query('SELECT COUNT(DISTINCT date)::int AS n FROM ga4_pages WHERE site_id = $1 AND date BETWEEN $2 AND $3', [siteId, cur.start, cur.end]),
    query('SELECT COUNT(DISTINCT date)::int AS n FROM ga4_pages WHERE site_id = $1 AND date BETWEEN $2 AND $3', [siteId, prev.start, prev.end]),
    query(`SELECT d.data_quality->'pages' AS pages
             FROM ga4_daily d
            WHERE d.site_id = $1 AND d.date BETWEEN $2 AND $3
              AND EXISTS (SELECT 1 FROM ga4_pages p WHERE p.site_id = d.site_id AND p.date = d.date)`, [siteId, cur.start, cur.end]),
  ]);

  return {
    pages,
    // `days` is how many days of the range actually have a page list, so a card can say "based on 9 of 28 days" while a
    // backfill is still catching up, rather than presenting a partial window as the whole period.
    current: { ...cur, days: curDays.n, daysInRange: spanDays(cur.start, cur.end) },
    previous: { ...prev, days: prevDays.n, daysInRange: spanDays(prev.start, prev.end) },
    dataQuality: describePagesQuality(quality),
  };
}

/** Record how well a day's page list covers that day's views, inside the day's existing quality JSON (no verdict change). */
export async function recordPagesQuality(siteId, date, quality) {
  if (!quality) return;
  await query(
    `UPDATE ga4_daily
        SET data_quality = jsonb_set(COALESCE(data_quality, '{}'::jsonb), '{pages}', $3::jsonb, true)
      WHERE site_id = $1 AND date = $2`,
    [siteId, date, JSON.stringify(quality)]
  );
}

/** Days that had traffic but no stored page list yet, newest first (the ones a backfill should fetch). */
export async function listDaysMissingPages(siteId, start, end, limit) {
  const { rows } = await query(
    `SELECT to_char(d.date, 'YYYY-MM-DD') AS date
       FROM ga4_daily d
      WHERE d.site_id = $1 AND d.date BETWEEN $2 AND $3 AND COALESCE(d.sessions, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM ga4_pages p WHERE p.site_id = d.site_id AND p.date = d.date)
      ORDER BY d.date DESC LIMIT $4`,
    [siteId, start, end, limit]
  );
  return rows.map((r) => r.date);
}
