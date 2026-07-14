import { query } from '../db.js';

// Generic per-agent rotation bookkeeping (migration 027) — lets any
// page-level agent get the same bounded "least-recently-checked first"
// rotation technical-seo.js proved via technical_seo_checks, without a
// dedicated table per agent. Keyed by (site_id, agent_id, page) precisely
// because a page checked by one agent isn't "checked" for another — they
// inspect entirely different things about the same page.

export async function getCheckedAtForPages(siteId, agentId, pages) {
  if (!pages.length) return new Map();
  const { rows } = await query(
    'SELECT page, checked_at FROM agent_page_rotation WHERE site_id = $1 AND agent_id = $2 AND page = ANY($3)',
    [siteId, agentId, pages]
  );
  return new Map(rows.map((r) => [r.page, r.checked_at]));
}

export async function markPagesChecked(siteId, agentId, pages) {
  if (!pages.length) return;
  await Promise.all(pages.map((page) => query(
    `INSERT INTO agent_page_rotation (site_id, agent_id, page, checked_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (site_id, agent_id, page) DO UPDATE SET checked_at = now()`,
    [siteId, agentId, page]
  )));
}
