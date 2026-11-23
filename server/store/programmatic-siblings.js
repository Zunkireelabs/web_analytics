import { query } from '../db.js';

// The site's other drafts of one generator, for the programmatic-page quality gate (generators/lib/programmatic-guard.js): is this new
// page mostly the same wording as the ones already made from the same template? Its own module, not drafts.js, because the gate must
// not depend on the (large, widely mocked) drafts store.
//
// Abandoned drafts are left out: nobody will publish them, so they are no sibling a visitor or Google would ever see.
// `excludeTarget` keeps a page from being compared with an earlier draft of ITSELF (a regeneration of the same page).
export async function listSiblingDrafts(siteId, generatorId, { excludeTarget = null, limit = 12, days = 180 } = {}) {
  const { rows } = await query(
    `SELECT id, content FROM drafts
      WHERE site_id = $1 AND action_type = $2
        AND status <> 'abandoned'
        AND created_at > now() - make_interval(days => $3)
        AND ($4::text IS NULL OR content->>'target' IS DISTINCT FROM $4)
      ORDER BY created_at DESC
      LIMIT $5`,
    [siteId, generatorId, days, excludeTarget, limit],
  );
  return rows;
}
