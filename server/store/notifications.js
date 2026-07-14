import { query } from '../db.js';

export async function saveNotification(siteId, { type, severity, title, body, findingIds = [] }) {
  await query(
    `INSERT INTO notifications (site_id, type, severity, title, body, finding_ids)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siteId, type, severity, title, body, findingIds]
  );
}

export async function listNotifications(siteId, limit = 30) {
  const { rows } = await query(
    `SELECT id, type, severity, title, body, finding_ids, read_at, created_at
       FROM notifications WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2`,
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
