// WHAT THE STATUS VIEW SHOWS: every active project's day, in one read. Nothing here is computed from guesses: the day record (delivery_cycles), its items
// (delivery_items), the three lifecycle facts on its pull requests (migration 271), and the alerts the same rules raise. Platform admins only (routes/platform.js).
import { query as defaultQuery } from '../db.js';
import { cycleDateIn } from './delivery-cycle.js';
import { renderPreservedDeliveryMarkdown } from './delivery-consolidation.js';
import { listLifecycleDrafts, summarizeLifecycle } from './delivery-lifecycle.js';
import { evaluateAlerts } from './delivery-alerts.js';
import { describeSession, sessionState, workerSessionTimezone } from './worker-session.js';

const shape = (c, items) => c && ({
  id: c.id, date: c.cycle_date, status: c.status, closed: !!c.closed_at, closedAt: c.closed_at, passes: c.passes, attempted: c.attempted, shipped: c.shipped, blocked: c.blocked, skipped: c.skipped,
  prUrl: c.pr_url, branch: c.branch_name, headSha: c.head_sha, blocker: c.blocker, recovery: c.recovery,
  preservedDelivery: c.stages?.delivery ? { ...c.stages.delivery, markdown: renderPreservedDeliveryMarkdown(c.stages.delivery) } : null,
  items: items.reduce((m, i) => { m[i.state] = (m[i.state] || 0) + 1; return m; }, {}),
  blockedItems: items.filter((i) => i.state === 'blocked' || i.state === 'refused').slice(0, 20).map((i) => ({ recommendationId: i.recommendation_id, draftId: i.content_draft_id, generator: i.generator_id, page: i.page, kind: i.blocked_kind, reason: i.blocked_reason, retryPolicy: i.retry_policy })),
});

/** @param {{sites:{id:number,name:string}[]}} p  the active projects (the caller decides who is active) */
export async function loadDeliveryStatus({ sites, now = new Date(), timezone = workerSessionTimezone(), query = defaultQuery, workerOnline = false } = {}) {
  const day = cycleDateIn(timezone, now);
  const ids = sites.map((s) => s.id);
  const { rows: cycles } = await query(`SELECT * FROM delivery_cycles WHERE site_id = ANY($1::int[]) AND cycle_date >= ($2::date - 6) ORDER BY cycle_date DESC`, [ids, day]);
  const { rows: items } = await query(`SELECT i.* FROM delivery_items i JOIN delivery_cycles c ON c.id = i.cycle_id WHERE c.site_id = ANY($1::int[]) AND c.cycle_date = $2::date`, [ids, day]);
  const { rows: locks } = await query(`SELECT job_key, acquired_at, heartbeat_at, expires_at FROM job_locks`);
  const today = cycles.filter((c) => String(c.cycle_date).slice(0, 10) === day || (c.cycle_date instanceof Date && cycleDateIn('UTC', c.cycle_date) === day));
  const perSite = []; const botMerged = []; const unverified = [];
  for (const s of sites) {
    const drafts = await listLifecycleDrafts(s.id, { query }).catch(() => []);
    const lc = summarizeLifecycle(drafts, { now });
    botMerged.push(...lc.mergedBot); unverified.push(...lc.mergedUnverified);
    const todays = today.find((c) => c.site_id === s.id) || null;
    perSite.push({
      siteId: s.id, name: s.name,
      today: shape(todays, items.filter((i) => i.cycle_id === todays?.id)),
      history: cycles.filter((c) => c.site_id === s.id).map((c) => ({ date: c.cycle_date, status: c.status, prUrl: c.pr_url, blocker: c.blocker })),
      lifecycle: lc.counts, waitingForReview: lc.waitingForReview.map((d) => ({ draftId: d.id, prUrl: d.pr_url, prNumber: d.pr_number })),
    });
  }
  const state = sessionState();
  const alerts = evaluateAlerts({ now, timezone, sites, cycles: today, locks, mergedByBot: botMerged, mergedUnverified: unverified, skippedTicks: state.skippedTicks });
  return { day, timezone, session: describeSession({ timezone, now, workerOnline, last: { running: state.running } }), sites: perSite, alerts };
}
