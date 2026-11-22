import { query as dbQuery } from '../db.js';
import { collectNeedsYou } from '../assistant/needs-you.js';
import { deliverToAllChannels } from '../notifications/channels/index.js';

// A person's approval can sit for days: a blog post waiting for a yes, a pull request waiting to be merged, the promotion PR to main.
// The assistant mentions it whenever they open it (assistant/needs-you.js marks it overdue); this is the part that does not depend on them
// opening anything — one reminder per site, through the dashboard bell (never email), with the alert gate's cooldown
// (notifications/alert-gate.js: 'approval-reminder', every 2 days at most). In-app only: no email, and the bell row does not count as the day's email, so it nags usefully without flooding.
// Read-only: it never approves, merges or changes anything. Everything it says is computed from the real waiting records.

export function buildReminderEvent(siteId, items) {
  const overdue = (items || []).filter((i) => i.overdue);
  if (!overdue.length) return null;
  const oldest = Math.max(...overdue.map((i) => i.ageDays));
  return {
    type: 'approval-reminder',
    channels: ['in-app'], // the dashboard bell only — never email
    severity: oldest >= 5 ? 'high' : 'medium',
    title: `${overdue.length} ${overdue.length === 1 ? 'item is' : 'items are'} waiting for your approval${oldest >= 2 ? ` (oldest: ${oldest} days)` : ''}`,
    body: overdue.slice(0, 5).map((i) => i.title.replace(/ — waiting.*$/, '')).join(' · ') + (overdue.length > 5 ? ` · and ${overdue.length - 5} more` : '') + '. Open the assistant and tell it to go ahead, or what to change.',
    // A stable identity per site, so the gate's cooldown sees "the same reminder" even though the wording changes as days pass.
    insightId: `approvals:${siteId}`,
  };
}

export async function runApprovalRemindersForAllSites({ query = dbQuery, collect = collectNeedsYou, deliver = deliverToAllChannels } = {}) {
  const { rows } = await query(`SELECT id FROM sites WHERE status = 'active' AND deleted_at IS NULL ORDER BY id`);
  const totals = { sites: rows.length, reminded: 0, failed: 0 };
  for (const { id } of rows) {
    try {
      const event = buildReminderEvent(id, await collect(id));
      if (!event) continue;
      await deliver(id, [event]);
      totals.reminded += 1;
    } catch (err) {
      totals.failed += 1;
      console.error(`[approval-reminders] site ${id}:`, err.message);
    }
  }
  return totals;
}
