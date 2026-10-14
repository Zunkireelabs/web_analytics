import { query } from '../db.js';

// Reads/writes for notification_decisions (migration 181) — the record of why
// each alert was or wasn't sent, and the backing store for keyed cooldowns.
// See the migration for why `notifications` alone can't answer either question.

export async function recordNotificationDecision(siteId, { eventType, eventKey, decision, reason = null, severity = null }) {
  await query(
    `INSERT INTO notification_decisions (site_id, event_type, event_key, decision, reason, severity)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siteId, eventType, eventKey, decision, reason, severity]
  );
}

// One INSERT for a whole batch. The gate decides every event in a batch at
// once, and a per-event round trip would put the batch size into the daily
// job's latency for no benefit.
export async function recordNotificationDecisions(siteId, decisions) {
  if (!decisions.length) return;
  const values = [];
  const params = [siteId];
  for (const d of decisions) {
    const base = params.length;
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(d.eventType, d.eventKey, d.decision, d.reason ?? null, d.severity ?? null);
  }
  await query(
    `INSERT INTO notification_decisions (site_id, event_type, event_key, decision, reason, severity)
     VALUES ${values.join(', ')}`,
    params
  );
}

// "Have we already TOLD them this, recently?"
//
// Only 'delivered' counts. A suppressed event must never satisfy a cooldown of
// its own — otherwise the first suppression would start a window that keeps
// renewing itself every time the gate runs, and the alert would be muted
// permanently instead of for `sinceDays`.
export async function hasRecentDeliveredDecision(siteId, eventType, eventKey, sinceDays) {
  const { rows } = await query(
    `SELECT 1 FROM notification_decisions
      WHERE site_id = $1 AND event_type = $2 AND event_key = $3
        AND decision = 'delivered'
        AND created_at >= now() - ($4 || ' days')::interval
      LIMIT 1`,
    [siteId, eventType, eventKey, sinceDays]
  );
  return rows.length > 0;
}

// Rollout evidence: what the gate did for one site over a window, newest
// first. Read this before switching ALERT_GATE_ENABLED on — a gate whose
// suppressions nobody has inspected is a gate nobody can trust.
export async function listNotificationDecisions(siteId, { sinceDays = 7, limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT event_type, event_key, decision, reason, severity, created_at
       FROM notification_decisions
      WHERE site_id = $1 AND created_at >= now() - ($2 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, sinceDays, limit]
  );
  return rows;
}
