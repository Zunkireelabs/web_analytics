import { query, pool } from '../db.js';

// Persistence for the drift monitor (migration 264). A snapshot is the SEO-critical facts of one page at one time
// (lib/seo-snapshot.js); the BASELINE is the one a later capture is compared against. Exactly one baseline per (site, url): the
// database enforces it, and every change of baseline here is one transaction, so there is never a moment with two or none.

const toSnapshot = (r) => (!r ? null : {
  id: Number(r.id), url: r.url, capturedAt: r.captured_at, statusCode: r.status_code,
  title: r.title, metaDescription: r.meta_description, canonical: r.canonical, robots: r.robots,
  h1: r.h1 || [], h2: r.h2 || [], schemaTypes: r.schema_types || [], schemaHash: r.schema_hash,
  openGraph: r.open_graph || {}, contentHash: r.content_hash, wordCount: r.word_count,
  isBaseline: r.is_baseline, baselineReason: r.baseline_reason,
});

export async function getBaseline(siteId, url) {
  const { rows } = await query('SELECT * FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 AND is_baseline', [siteId, url]);
  return toSnapshot(rows[0]);
}

// Every baseline of the site in one read (the nightly run compares ~25 pages; one query, not 25).
export async function getBaselines(siteId, urls) {
  if (!urls.length) return new Map();
  const { rows } = await query('SELECT * FROM seo_page_snapshots WHERE site_id = $1 AND url = ANY($2) AND is_baseline', [siteId, urls]);
  return new Map(rows.map((r) => [r.url, toSnapshot(r)]));
}

// Stores a capture. `baselineReason` set = this capture becomes the page's baseline (replacing any current one).
export async function insertSnapshot(siteId, url, snap, { baselineReason = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (baselineReason) await client.query('UPDATE seo_page_snapshots SET is_baseline = false, baseline_reason = NULL WHERE site_id = $1 AND url = $2 AND is_baseline', [siteId, url]);
    const { rows } = await client.query(
      `INSERT INTO seo_page_snapshots
         (site_id, url, status_code, title, meta_description, canonical, robots, h1, h2, schema_types, schema_hash, open_graph, content_hash, word_count, is_baseline, baseline_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16) RETURNING *`,
      [siteId, url, snap.statusCode, snap.title, snap.metaDescription, snap.canonical, snap.robots, JSON.stringify(snap.h1 || []), JSON.stringify(snap.h2 || []),
        JSON.stringify(snap.schemaTypes || []), snap.schemaHash, JSON.stringify(snap.openGraph || {}), snap.contentHash, snap.wordCount, Boolean(baselineReason), baselineReason],
    );
    await client.query('COMMIT');
    return toSnapshot(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "This change is intended": the page's latest capture becomes its baseline, so it stops being reported. Returns the new baseline,
// or null when the page has never been captured. Scoped to the site, so a url from another project can never be touched.
export async function acceptLatestAsBaseline(siteId, url) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [latest] } = await client.query('SELECT id FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 ORDER BY captured_at DESC, id DESC LIMIT 1 FOR UPDATE', [siteId, url]);
    if (!latest) { await client.query('ROLLBACK'); return null; }
    await client.query('UPDATE seo_page_snapshots SET is_baseline = false, baseline_reason = NULL WHERE site_id = $1 AND url = $2 AND is_baseline', [siteId, url]);
    const { rows } = await client.query(`UPDATE seo_page_snapshots SET is_baseline = true, baseline_reason = 'accepted' WHERE id = $1 RETURNING *`, [latest.id]);
    await client.query('COMMIT');
    return toSnapshot(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Keeps the most recent `keep` NON-baseline captures of a page; the baseline is never removed.
export async function pruneSnapshots(siteId, url, keep = 30) {
  await query(
    `DELETE FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 AND NOT is_baseline
       AND id NOT IN (SELECT id FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 AND NOT is_baseline ORDER BY captured_at DESC, id DESC LIMIT $3)`,
    [siteId, url, keep],
  );
}

// Pages WE changed since `since`: drafts that reached "implemented" (a fix that went live on that page). Returns Map(lowercased page
// key -> latest implemented_at), where the key is the page exactly as the draft recorded it (a full URL or a path). A page that
// changed after a fix of ours on it is expected to differ from its baseline; the monitor uses this to not alarm on its own work.
export async function ownChangesSince(siteId, since) {
  const { rows } = await query(
    `SELECT lower(input->>'page') AS page, max(implemented_at) AS at
       FROM drafts WHERE site_id = $1 AND status = 'implemented' AND implemented_at >= $2 AND input->>'page' IS NOT NULL
      GROUP BY 1`,
    [siteId, since],
  );
  return new Map(rows.map((r) => [r.page, new Date(r.at)]));
}

export async function latestSnapshots(siteId, limit = 200) {
  const { rows } = await query(
    `SELECT DISTINCT ON (url) * FROM seo_page_snapshots WHERE site_id = $1 ORDER BY url, captured_at DESC, id DESC LIMIT $2`,
    [siteId, limit],
  );
  return rows.map(toSnapshot);
}
