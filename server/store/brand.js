import { query } from '../db.js';

// What a project's own people tell the agents about their brand: documents (grounding text) and topics they want blogs on.
// Every query is scoped by site_id; nothing here reads or returns another project's rows.

export const MAX_DOC_CHARS = 50_000;     // one document
export const MAX_DOCS = 20;              // per project
export const PROMPT_DOC_CHARS = 6_000;   // all documents together, in an agent's prompt

export const MAX_ABOUT_CHARS = 4_000;

export async function getBrandAbout(siteId) {
  const { rows } = await query('SELECT about, updated_at FROM brand_about WHERE site_id = $1', [siteId]);
  return rows[0] || { about: '', updated_at: null };
}

export async function setBrandAbout(siteId, about, userId = null) {
  const { rows } = await query(
    `INSERT INTO brand_about (site_id, about, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (site_id) DO UPDATE SET about = EXCLUDED.about, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING about, updated_at`,
    [siteId, about, userId]);
  return rows[0];
}

export async function listBrandDocuments(siteId) {
  const { rows } = await query(
    `SELECT id, name, bytes, created_at, left(content, 240) AS excerpt FROM brand_documents WHERE site_id = $1 ORDER BY created_at DESC`, [siteId]);
  return rows;
}

export async function addBrandDocument(siteId, { name, content }, userId = null) {
  const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM brand_documents WHERE site_id = $1', [siteId]);
  if (n >= MAX_DOCS) { const e = new Error(`A project can keep ${MAX_DOCS} documents. Remove one first.`); e.status = 409; throw e; }
  const { rows } = await query(
    `INSERT INTO brand_documents (site_id, name, content, bytes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, bytes, created_at, left(content, 240) AS excerpt`,
    [siteId, name, content, Buffer.byteLength(content, 'utf8'), userId]);
  return rows[0];
}

export async function deleteBrandDocument(siteId, id) {
  const { rowCount } = await query('DELETE FROM brand_documents WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rowCount > 0;
}

/** Everything the project's own people told us, as ONE block for the agents writing for it: what the brand is, its documents, and the topics it wants to be known for.
 *  '' when there is none of it. Documents are newest first and cut to a total budget. */
export async function brandDocumentsPrompt(siteId, { maxChars = PROMPT_DOC_CHARS } = {}) {
  if (siteId == null) return '';
  const [about, docs, topics] = await Promise.all([
    getBrandAbout(siteId),
    query('SELECT name, content FROM brand_documents WHERE site_id = $1 ORDER BY created_at DESC', [siteId]).then((r) => r.rows),
    listRequestedTopics(siteId, 15).catch(() => []),
  ]);
  const parts = [];
  if (String(about.about || '').trim()) parts.push(`What the brand is, in its own words:\n${String(about.about).trim()}`);
  const topicList = topics.filter((t) => t.status !== 'dismissed').map((t) => t.topic);
  if (topicList.length) parts.push(`Topics the company wants to be known for: ${topicList.join('; ')}.`);
  let left = maxChars;
  for (const r of docs) {
    if (left <= 200) break;
    const text = String(r.content).replace(/\s+\n/g, '\n').trim().slice(0, left - 60);
    parts.push(`[${r.name}]\n${text}`);
    left -= text.length + r.name.length + 6;
  }
  if (!parts.length) return '';
  return `What the company has told us about its brand. Follow its voice, terms and facts; never contradict them, and never state anything about the company they do not support:\n${parts.join('\n\n')}`;
}

/** Topics the project's people asked a blog for (they enter the review queue as 'user_request'). */
export async function listRequestedTopics(siteId, limit = 100) {
  const { rows } = await query(
    `SELECT id, topic, status, content_plan, created_at FROM keyword_gaps WHERE site_id = $1 AND source = 'user_request' ORDER BY created_at DESC LIMIT $2`, [siteId, limit]);
  return rows;
}
