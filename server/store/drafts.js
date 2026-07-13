import { query } from '../db.js';

// CRUD for the drafts table. Every write scopes by site_id so one site's
// drafts can never be read or edited via another site's session. No publish
// operation exists here — deleteDraft is the only way a draft goes away.

export async function createDraft(siteId, { actionType, source, input, content }) {
  const { rows } = await query(
    `INSERT INTO drafts (site_id, action_type, source, input, content)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [siteId, actionType, source ?? null, JSON.stringify(input ?? {}), JSON.stringify(content)]
  );
  return rows[0];
}

export async function listDrafts(siteId, { actionType, status } = {}) {
  const conditions = ['site_id = $1'];
  const values = [siteId];
  if (actionType) { values.push(actionType); conditions.push(`action_type = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  const { rows } = await query(
    `SELECT * FROM drafts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function getDraft(siteId, id) {
  const { rows } = await query('SELECT * FROM drafts WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rows[0] || null;
}

export async function updateDraft(siteId, id, { content }) {
  const { rows } = await query(
    `UPDATE drafts SET content = $1, status = 'edited', updated_at = now()
     WHERE site_id = $2 AND id = $3
     RETURNING *`,
    [JSON.stringify(content), siteId, id]
  );
  return rows[0] || null;
}

export async function deleteDraft(siteId, id) {
  const { rowCount } = await query('DELETE FROM drafts WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rowCount > 0;
}

// Real evidence a recommendation was actually acted on, not just that it
// disappeared — used by the Opportunity Watchlist (agents/lib/watchlist.js)
// to distinguish "completed" (a draft exists for this exact action) from
// "no longer applicable" (it just stopped being relevant).
export async function hasDraftSince(siteId, source, actionType, since) {
  const { rows } = await query(
    'SELECT 1 FROM drafts WHERE site_id = $1 AND source = $2 AND action_type = $3 AND created_at >= $4 LIMIT 1',
    [siteId, source, actionType, since]
  );
  return rows.length > 0;
}
