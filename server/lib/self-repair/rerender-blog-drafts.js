// RE-RENDER ABANDONED ARTICLES. A complete article abandoned because the render check measured it differently from the site's real article page keeps its
// content (abandoning never deletes it). When the renderer or the measurement was at fault and has since been corrected, the article does not need to be
// rewritten: its stored body is rendered again with the current code and put through the SAME rendering gate, unchanged. It is restored to 'draft' only if
// that gate passes; if not, it stays abandoned and the new failure is reported. The gate is never relaxed to let an article through.
//
// Dry-run by default (renders and checks, writes nothing). `apply` restores the ones that pass, one project at a time, scoped by site_id in every statement.
// Applying is a production data write: a person approves it (scripts/rerender-abandoned-blog-drafts.js backs the rows up first), or the project's owner turns
// on SELF_REPAIR_ACT.
const MISMATCH = '%measures differently%';
const defaultQuery = async (...a) => (await import('../../db.js')).query(...a);

export const selfRepairActMode = (env = process.env) => (String(env.SELF_REPAIR_ACT || 'off').toLowerCase() === 'on' ? 'on' : 'off');

export async function listRerenderCandidates(siteId, { query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT id, site_id, action_type, status, content, input, abandoned_reason, abandoned_at, rendered_body, target_file_path
       FROM drafts WHERE site_id = $1 AND action_type = 'blog-outline' AND status = 'abandoned' AND abandoned_reason ILIKE $2 ORDER BY id`, [siteId, MISMATCH]);
  return rows;
}

/**
 * @param {number} siteId
 * @param {object} o
 *   apply            false (default) = report only
 *   getSite          (siteId) => site row (with url_file_map, repo)
 *   resolveTargetAndBody, validateRendering   the real ones (frontend.js, rendering-gate.js); injected so the logic is testable
 *   backup           async (rows) => void, called before the first write (the caller stores it outside the repo)
 */
export async function rerenderAbandonedBlogDrafts(siteId, { apply = false, query = defaultQuery, getSite, resolveTargetAndBody, validateRendering, backup = null, log = console } = {}) {
  const site = await getSite(siteId);
  const out = { siteId, apply, candidates: 0, restorable: 0, restored: 0, stillFailing: 0, items: [] };
  if (!site?.repo_owner || !site?.repo_name) return { ...out, skipped: 'no-repository' };
  const rows = await listRerenderCandidates(siteId, { query });
  out.candidates = rows.length;
  if (apply && rows.length && backup) await backup(rows);
  for (const d of rows) {
    const item = { draftId: d.id, wasReason: String(d.abandoned_reason || '').slice(0, 160), result: null };
    try {
      const resolved = await resolveTargetAndBody(site, { action_type: 'blog-outline', content: d.content, input: d.input || {} }); // fresh: ignores the stored rendered_body
      if (!resolved.ok) { item.result = 'cannot-render'; item.detail = resolved.error; out.stillFailing++; out.items.push(item); continue; }
      const check = await validateRendering(site, { path: resolved.filePath, content: resolved.body, contentFormat: resolved.contentFormat, actionType: 'blog-outline' });
      if (!check.ok) { item.result = 'still-fails-the-gate'; item.detail = String(check.error || '').slice(0, 240); out.stillFailing++; out.items.push(item); continue; }
      item.result = apply ? 'restored' : 'would-restore'; out.restorable++;
      if (apply) {
        const { rowCount } = await query(
          `UPDATE drafts SET status = 'draft', rendered_body = $3, target_file_path = $4, abandoned_at = NULL, abandoned_by = NULL, abandoned_reason = NULL, apply_error = NULL,
                  revision_reason = $5, updated_at = now()
            WHERE site_id = $1 AND id = $2 AND status = 'abandoned' AND action_type = 'blog-outline'`,
          [siteId, d.id, resolved.body, resolved.filePath, `Re-rendered by self-repair after the renderer was corrected and passed the unchanged rendering gate (was: ${item.wasReason})`]);
        if (rowCount) out.restored++; else item.result = 'changed-meanwhile';
      }
    } catch (err) {
      item.result = 'error'; item.detail = err.message; out.stillFailing++;
      log.error?.(`[self-repair] site ${siteId} draft ${d.id}: ${err.message}`);
    }
    out.items.push(item);
  }
  return out;
}
