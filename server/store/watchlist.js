import { query } from '../db.js';

// A closed (completed/no_longer_applicable) item's underlying finding
// reappearing is NOT by itself new information — priority/evidence/impact
// naturally jitter slightly run to run. Only a real change to what the
// finding actually says should overturn the user's decision to close it.
// Returns a human-readable reason string when something material changed,
// or null when the reappearance should be ignored and the item stays closed.
function materialChangeDetected(existing, incoming) {
  if (existing.priority !== incoming.priority) {
    return `priority changed from ${existing.priority} to ${incoming.priority}`;
  }
  const exImpact = existing.expected_impact?.label ?? null;
  const inImpact = incoming.expectedImpact?.label ?? null;
  if (exImpact !== inImpact) {
    return `expected impact changed from ${exImpact || 'unknown'} to ${inImpact || 'unknown'}`;
  }
  const exGenerator = existing.recommended_action?.generatorId ?? null;
  const inGenerator = incoming.recommendedAction?.generatorId ?? null;
  if (exGenerator !== inGenerator) {
    return 'the recommended action changed';
  }
  if (JSON.stringify(existing.evidence ?? null) !== JSON.stringify(incoming.evidence ?? null)) {
    return 'the supporting evidence changed';
  }
  return null;
}

// Insert-or-refresh one opportunity by its stable finding_id.
//  - New finding_id: plain insert as 'new'.
//  - Still open (new/in_progress): snapshot fields refresh in place (priority/
//    impact/evidence can shift run to run); status/discovered_at untouched.
//  - Closed (completed/no_longer_applicable): the user's decision stands
//    unless materialChangeDetected() finds a real change — only then does it
//    reopen as 'new', with a history entry recording why.
export async function upsertWatchlistItem(siteId, item) {
  const { rows: existingRows } = await query(
    'SELECT * FROM watchlist_items WHERE site_id = $1 AND finding_id = $2',
    [siteId, item.findingId]
  );
  const existing = existingRows[0];

  // Snapshot fields shared by every UPDATE below (insert has its own full
  // param list, since it also needs site_id/opportunity_type/finding_id/agent_id).
  const snapshotFields = [
    item.title, item.reason, item.priority,
    item.expectedImpact ? JSON.stringify(item.expectedImpact) : null,
    item.confidence || null, item.evidence ? JSON.stringify(item.evidence) : null,
    item.recommendedAction ? JSON.stringify(item.recommendedAction) : null,
  ];

  if (!existing) {
    const { rows } = await query(
      `INSERT INTO watchlist_items
         (site_id, opportunity_type, finding_id, agent_id, title, reason, priority, expected_impact, confidence, evidence, recommended_action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, status`,
      [siteId, item.opportunityType || 'growth', item.findingId, item.agentId, ...snapshotFields]
    );
    await recordWatchlistHistory(rows[0].id, null, 'new', 'Discovered.');
    return rows[0];
  }

  if (existing.status === 'new' || existing.status === 'in_progress') {
    const { rows } = await query(
      `UPDATE watchlist_items SET
         title = $3, reason = $4, priority = $5, expected_impact = $6,
         confidence = $7, evidence = $8, recommended_action = $9
       WHERE site_id = $1 AND finding_id = $2
       RETURNING id, status`,
      [siteId, item.findingId, ...snapshotFields]
    );
    return rows[0];
  }

  const changeReason = materialChangeDetected(existing, item);
  if (!changeReason) {
    // Reappeared unchanged — preserve the user's decision, touch nothing.
    return { id: existing.id, status: existing.status };
  }

  const { rows } = await query(
    `UPDATE watchlist_items SET
       title = $3, reason = $4, priority = $5, expected_impact = $6,
       confidence = $7, evidence = $8, recommended_action = $9,
       status = 'new', discovered_at = now(), status_changed_at = now()
     WHERE site_id = $1 AND finding_id = $2
     RETURNING id, status`,
    [siteId, item.findingId, ...snapshotFields]
  );
  await recordWatchlistHistory(rows[0].id, existing.status, 'new', `Reopened — ${changeReason}.`);
  return rows[0];
}

export async function recordWatchlistHistory(watchlistItemId, fromStatus, toStatus, reason) {
  await query(
    `INSERT INTO watchlist_item_history (watchlist_item_id, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4)`,
    [watchlistItemId, fromStatus, toStatus, reason]
  );
}

export async function getWatchlistHistory(watchlistItemId) {
  const { rows } = await query(
    'SELECT from_status, to_status, reason, changed_at FROM watchlist_item_history WHERE watchlist_item_id = $1 ORDER BY changed_at DESC',
    [watchlistItemId]
  );
  return rows;
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
    const { rows } = await query(
      `UPDATE watchlist_items SET status = $3, status_changed_at = now()
        WHERE site_id = $1 AND finding_id = $2 AND status IN ('new', 'in_progress')
        RETURNING id, status`,
      [siteId, findingId, resolution]
    );
    if (rows[0]) {
      await recordWatchlistHistory(rows[0].id, 'open', resolution, resolution === 'completed' ? 'A draft was generated for this recommendation.' : 'No longer present in the latest analysis.');
      closed++;
    }
  }
  return closed;
}

// `last_transition_*` surfaces the most recent history entry inline so the
// UI can show "reopened — {reason}" without a second request per item.
const WITH_LAST_TRANSITION = `
  SELECT w.*, h.reason AS last_transition_reason, h.to_status AS last_transition_status,
         h.from_status AS last_transition_from, h.changed_at AS last_transition_at
    FROM watchlist_items w
    LEFT JOIN LATERAL (
      SELECT reason, to_status, from_status, changed_at FROM watchlist_item_history
       WHERE watchlist_item_id = w.id ORDER BY changed_at DESC LIMIT 1
    ) h ON true
`;

export async function listWatchlist(siteId, { status } = {}) {
  const { rows } = status
    ? await query(`${WITH_LAST_TRANSITION} WHERE w.site_id = $1 AND w.status = $2 ORDER BY w.discovered_at DESC`, [siteId, status])
    : await query(`${WITH_LAST_TRANSITION} WHERE w.site_id = $1 ORDER BY w.discovered_at DESC`, [siteId]);
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

// Single-row lookup by the watchlist item's own id — used by the Verify
// stage (agents/lib/fix-verification.js) to check whether an item is
// currently closed before reopening it.
export async function getWatchlistItemById(siteId, id) {
  const { rows } = await query('SELECT * FROM watchlist_items WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rows[0] || null;
}

// User-driven status change (e.g. "Mark In Progress" / "Dismiss"), distinct
// from the automatic sync transitions above. Always recorded to history too
// — a manual close needs the same audit trail an automatic one gets.
export async function setWatchlistStatus(siteId, id, status, reason = null) {
  const { rows: before } = await query('SELECT status FROM watchlist_items WHERE site_id = $1 AND id = $2', [siteId, id]);
  if (!before[0]) return null;
  const { rows } = await query(
    `UPDATE watchlist_items SET status = $3, status_changed_at = now()
      WHERE site_id = $1 AND id = $2 RETURNING id, status`,
    [siteId, id, status]
  );
  const row = rows[0];
  if (row) await recordWatchlistHistory(row.id, before[0].status, status, reason || 'Marked by user.');
  return row || null;
}
