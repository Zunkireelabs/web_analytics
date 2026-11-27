// Database half of the content index (migration 270). Rebuilt from the real sources, never edited by hand; every query carries the site id.
import { query as defaultQuery } from '../../db.js';
import { buildIndexEntries, detectBlogRoots } from './build.js';

const LIVE_DRAFT_STATUSES = ['draft', 'edited', 'submitted_for_approval', 'revision_requested', 'approved', 'branch_pushed', 'awaiting_publish', 'pr_opened', 'merged_to_stage', 'implemented'];
export const INDEX_MAX_AGE_MS = Number(process.env.CONTENT_INDEX_MAX_AGE_MS) || 30 * 60_000;

const rowToEntry = (r) => ({
  refKey: r.ref_key, kind: r.kind, state: r.state, url: r.url, title: r.title, topicKey: r.topic_key, tokens: r.tokens || [], source: r.source,
  draftId: r.draft_id, branchName: r.branch_name, prUrl: r.pr_url, filePath: r.file_path, fileSha: r.file_sha, contentHash: r.content_hash, lastSeenAt: r.last_seen_at,
});

/** Reads the real sources and rewrites this project's index. Returns counts by state and kind. */
export async function refreshContentIndex(siteId, { query = defaultQuery, listingRoots = null } = {}) {
  const [{ rows: inventory }, { rows: snapshots }, { rows: classifications }, { rows: drafts }] = await Promise.all([
    query(`SELECT page, orphaned FROM page_inventory WHERE site_id = $1 AND COALESCE(http_status, 200) < 400 LIMIT 20000`, [siteId]),
    query(`SELECT DISTINCT ON (url) url, title, h1, schema_types, open_graph, content_hash, status_code FROM seo_page_snapshots WHERE site_id = $1 ORDER BY url, captured_at DESC LIMIT 20000`, [siteId]).catch(() => ({ rows: [] })),
    query(`SELECT page, content_type, confidence FROM page_content_classification WHERE site_id = $1`, [siteId]).catch(() => ({ rows: [] })),
    query(`SELECT id, action_type, status, pr_state, pr_url, branch_name, target_file_path, content, input FROM drafts
            WHERE site_id = $1 AND status = ANY($2::text[]) AND action_type = ANY($3::text[])`, [siteId, LIVE_DRAFT_STATUSES, ['blog-outline']]),
  ]);
  let roots = listingRoots;
  if (!roots) {
    // The urls of every page we know of (inventory AND snapshots): the roots come from the site's own structure, not from a name pattern.
    const paths = [...inventory.map((r) => r.page), ...snapshots.map((r) => r.url)].map((u) => { try { return new URL(u).pathname; } catch { return null; } }).filter(Boolean);
    roots = detectBlogRoots(paths);
  }
  const entries = buildIndexEntries({ inventory, snapshots, classifications, drafts, listingRoots: roots });
  const refKeys = entries.map((e) => e.refKey);
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    await query(
      `INSERT INTO content_index (site_id, ref_key, kind, state, url, title, topic_key, tokens, source, draft_id, branch_name, pr_url, file_path, content_hash)
       SELECT $1, ref_key, kind, state, url, title, topic_key, COALESCE(string_to_array(NULLIF(tokens, ''), ' '), ARRAY[]::text[]), source, draft_id, branch_name, pr_url, file_path, content_hash
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::text[], $12::text[], $13::text[], $14::text[])
              AS t(ref_key, kind, state, url, title, topic_key, tokens, source, draft_id, branch_name, pr_url, file_path, content_hash)
       ON CONFLICT (site_id, ref_key) DO UPDATE SET kind = EXCLUDED.kind, state = EXCLUDED.state, url = EXCLUDED.url, title = EXCLUDED.title, topic_key = EXCLUDED.topic_key,
         tokens = EXCLUDED.tokens, source = EXCLUDED.source, draft_id = EXCLUDED.draft_id, branch_name = EXCLUDED.branch_name, pr_url = EXCLUDED.pr_url,
         file_path = EXCLUDED.file_path, content_hash = EXCLUDED.content_hash, last_seen_at = now()`,
      [siteId, part.map((e) => e.refKey), part.map((e) => e.kind), part.map((e) => e.state), part.map((e) => e.url), part.map((e) => e.title), part.map((e) => e.topicKey),
        part.map((e) => (e.tokens || []).join(' ')), part.map((e) => e.source), part.map((e) => e.draftId), part.map((e) => e.branchName), part.map((e) => e.prUrl),
        part.map((e) => e.filePath), part.map((e) => e.contentHash)]);
  }
  // What is no longer in the real sources leaves the index (a page that was removed, a draft that was abandoned).
  await query(`DELETE FROM content_index WHERE site_id = $1 AND NOT (ref_key = ANY($2::text[]))`, [siteId, refKeys]);
  const counts = {};
  for (const e of entries) { const k = `${e.state}:${e.kind}`; counts[k] = (counts[k] || 0) + 1; }
  return { siteId, total: entries.length, counts, listingRoots: roots };
}

/** The project's index entries. */
export async function loadContentIndex(siteId, { query = defaultQuery } = {}) {
  const { rows } = await query(`SELECT * FROM content_index WHERE site_id = $1`, [siteId]);
  return rows.map(rowToEntry);
}

/** Entries, refreshing first when the stored index is older than `maxAgeMs` (or empty). Never throws: on failure the stale index is returned with `stale: true`. */
export async function getFreshContentIndex(siteId, { query = defaultQuery, maxAgeMs = INDEX_MAX_AGE_MS, now = Date.now() } = {}) {
  try {
    const { rows: [m] } = await query(`SELECT max(last_seen_at) AS at, count(*)::int AS n FROM content_index WHERE site_id = $1`, [siteId]);
    const fresh = m?.n > 0 && m.at && now - new Date(m.at).getTime() < maxAgeMs;
    if (!fresh) await refreshContentIndex(siteId, { query });
    return { entries: await loadContentIndex(siteId, { query }), stale: false };
  } catch (err) {
    console.error(`[content-index] site ${siteId}: refresh failed (${err.message}); using what is stored`);
    try { return { entries: await loadContentIndex(siteId, { query }), stale: true, error: err.message }; } catch { return { entries: [], stale: true, error: err.message }; }
  }
}
