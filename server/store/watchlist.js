import { query } from '../db.js';

// Insert-or-refresh one opportunity by its stable finding_id. On conflict:
// a still-open item (new/in_progress) gets its snapshot refreshed (priority/
// impact/evidence can shift run to run) without disturbing status or
// discovered_at; a previously-closed item (completed/no_longer_applicable)
// whose finding reappeared gets revived as a fresh 'new' entry — a genuine
// second occurrence of relevance, not a status the sync logic should silently
// overwrite.
export async function upsertWatchlistItem(siteId, item) {
  const { rows } = await query(
    `INSERT INTO watchlist_items
       (site_id, opportunity_type, finding_id, agent_id, title, reason, priority, expected_impact, confidence, evidence, recommended_action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (site_id, finding_id) DO UPDATE SET
       title = EXCLUDED.title, reason = EXCLUDED.reason, priority = EXCLUDED.priority,
       expected_impact = EXCLUDED.expected_impact, confidence = EXCLUDED.confidence,
       evidence = EXCLUDED.evidence, recommended_action = EXCLUDED.recommended_action,
       status = CASE WHEN watchlist_items.status IN ('completed', 'no_longer_applicable') THEN 'new' ELSE watchlist_items.status END,
       discovered_at = CASE WHEN watchlist_items.status IN ('completed', 'no_longer_applicable') THEN now() ELSE watchlist_items.discovered_at END,
       status_changed_at = CASE WHEN watchlist_items.status IN ('completed', 'no_longer_applicable') THEN now() ELSE watchlist_items.status_changed_at END
     RETURNING id, status`,
    [
      siteId, item.opportunityType || 'growth', item.findingId, item.agentId, item.title, item.reason,
      item.priority, item.expectedImpact ? JSON.stringify(item.expectedImpact) : null,
      item.confidence || null, item.evidence ? JSON.stringify(item.evidence) : null,
      item.recommendedAction ? JSON.stringify(item.recommendedAction) : null,
    ]
  );
  return rows[0];
}

// Auto-close every still-open item whose finding_id is NOT in `stillPresentIds`
// — i.e. it fell out of the latest agent run. `resolution` is 'completed' when
// there's real evidence the action was taken (a draft exists for it),
// 'no_longer_applicable' otherwise (it just stopped being relevant).
export async function closeWatchlistItems(siteId, findingIdToResolution) {
  const entries = Object.entries(findingIdToResolution);
  if (!entries.length) return 0;
  let closed = 0;
  for (const [findingId, resolution] of entries) {
    const { rowCount } = await query(
      `UPDATE watchlist_items SET status = $3, status_changed_at = now()
        WHERE site_id = $1 AND finding_id = $2 AND status IN ('new', 'in_progress')`,
      [siteId, findingId, resolution]
    );
    closed += rowCount;
  }
  return closed;
}

export async function listWatchlist(siteId, { status } = {}) {
  const { rows } = status
    ? await query('SELECT * FROM watchlist_items WHERE site_id = $1 AND status = $2 ORDER BY discovered_at DESC', [siteId, status])
    : await query('SELECT * FROM watchlist_items WHERE site_id = $1 ORDER BY discovered_at DESC', [siteId]);
  return rows;
}

// Every currently-open (new/in_progress) item, full row — the sync logic's
// "what do we already know about" set. Full rows, not just ids, because
// closing one needs its agent_id/recommended_action to check for real
// evidence of action taken (see agents/lib/watchlist.js).
export async function getOpenItems(siteId) {
  const { rows } = await query(
    "SELECT * FROM watchlist_items WHERE site_id = $1 AND status IN ('new', 'in_progress')",
    [siteId]
  );
  return rows;
}

// User-driven status change (e.g. "Mark In Progress" / "Dismiss"), distinct
// from the automatic sync transitions above.
export async function setWatchlistStatus(siteId, id, status) {
  const { rows } = await query(
    `UPDATE watchlist_items SET status = $3, status_changed_at = now()
      WHERE site_id = $1 AND id = $2 RETURNING id, status`,
    [siteId, id, status]
  );
  return rows[0] || null;
}
