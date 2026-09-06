import { query } from '../db.js';

export async function saveNotification(siteId, { type, severity, title, body, findingIds = [] }) {
  await query(
    `INSERT INTO notifications (site_id, type, severity, title, body, finding_ids)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siteId, type, severity, title, body, findingIds]
  );
}

// draft_id: the most recent real draft already generated for any of this
// notification's finding_ids, if one exists — lets the frontend send a
// click straight to "where the agent decided how to fix it" (Action
// Center, that draft opened) instead of just highlighting the finding.
// Not every finding has a draft (some are structural-only, no generator),
// so this is null for those — the frontend falls back to today's
// highlight-on-Command-Center behavior in that case.
export async function listNotifications(siteId, limit = 30) {
  const { rows } = await query(
    `SELECT n.id, n.type, n.severity, n.title, n.body, n.finding_ids, n.read_at, n.created_at,
            d.id AS draft_id
       FROM notifications n
       LEFT JOIN LATERAL (
         SELECT id FROM drafts
          WHERE site_id = n.site_id AND finding_id = ANY(n.finding_ids)
          ORDER BY created_at DESC
          LIMIT 1
       ) d ON true
      WHERE n.site_id = $1
      ORDER BY n.created_at DESC LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function unreadCount(siteId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE site_id = $1 AND read_at IS NULL',
    [siteId]
  );
  return rows[0]?.count ?? 0;
}

export async function markRead(siteId, id) {
  await query('UPDATE notifications SET read_at = now() WHERE site_id = $1 AND id = $2 AND read_at IS NULL', [siteId, id]);
}

export async function markAllRead(siteId) {
  await query('UPDATE notifications SET read_at = now() WHERE site_id = $1 AND read_at IS NULL', [siteId]);
}

// Cooldown check for event types that can otherwise fire near-daily for the
// same underlying condition (e.g. health-drop) — a real notification of this
// type within the window means "already told them," not "tell them again."
export async function hasRecentNotification(siteId, type, sinceDays) {
  const { rows } = await query(
    `SELECT 1 FROM notifications WHERE site_id = $1 AND type = $2 AND created_at >= now() - ($3 || ' days')::interval LIMIT 1`,
    [siteId, type, sinceDays]
  );
  return rows.length > 0;
}
