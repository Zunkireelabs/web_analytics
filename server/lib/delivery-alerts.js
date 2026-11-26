// ALERTS for the autonomous delivery system: the things that used to fail silently and are now said out loud (and written down).
// Pure decision (evaluateAlerts) so every rule is tested; the database snapshot and the delivery are thin wrappers (runDeliveryAlerts in job.js).
//
// Rules, each from something that really happened or must never happen:
//   missing-record     after the day's close, an active project has NO closed day record (a project must never disappear from a day)
//   preserved          work is safe but its pull request is not open: a person must act if the retry does not succeed
//   unreached          the day closed before this project was reached
//   hung-lock          a job holds its lock for hours (2026-11-25: the startup daily job held its lock 5+ hours and the hourly guard only printed "skipped")
//   merged-by-bot      a pull request was merged by an app account: this system never merges. Critical.
//   merged-unverified  a person merged it days ago and the live page still does not show the change
//   worker-offline     inside the window, the laptop worker was not connected for a long run of ticks
//   in-flight-at-close a project was still shipping when the last close ran (its record says so)
// Every alert has a stable key so it is stated once per day, not every hour.
import { minuteOfDay, SESSION_START_MINUTE, SESSION_CUTOFF_MINUTE, CLOSE_FORCE_AFTER_MIN } from './worker-session.js';

export const SEVERITY = Object.freeze({ CRITICAL: 'critical', HIGH: 'high', WARNING: 'warning' });
export const HUNG_LOCK_HOURS = 3;
export const WORKER_OFFLINE_MIN = 30;

/**
 * @param {object} s  { now, timezone, sites:[{id,name}], cycles:[delivery_cycles rows for today], locks:[{job_key, acquired_at, heartbeat_at, expires_at}],
 *                      mergedByBot:[drafts], mergedUnverified:[drafts], skippedTicks:[{why,count,firstAt,lastAt}] }
 * @returns {{key:string, severity:string, siteId:number|null, message:string}[]}
 */
export function evaluateAlerts({ now = new Date(), timezone = 'Asia/Kathmandu', sites = [], cycles = [], locks = [], mergedByBot = [], mergedUnverified = [], skippedTicks = [] } = {}) {
  const out = []; const nowMs = new Date(now).getTime(); const minute = minuteOfDay(timezone, now);
  const afterClose = minute >= SESSION_CUTOFF_MINUTE + CLOSE_FORCE_AFTER_MIN;
  const byId = new Map(cycles.map((c) => [c.site_id, c]));
  const name = (id) => sites.find((s) => s.id === id)?.name || `site ${id}`;

  if (afterClose) {
    for (const s of sites) {
      const c = byId.get(s.id);
      if (!c || !c.closed_at) out.push({ key: `missing-record:${s.id}`, severity: SEVERITY.CRITICAL, siteId: s.id, message: `${name(s.id)} has no closed day record after the deadline. A project must never disappear from a day.` });
    }
  }
  for (const c of cycles) {
    if (c.status === 'preserved') out.push({ key: `preserved:${c.site_id}`, severity: SEVERITY.HIGH, siteId: c.site_id, message: `${name(c.site_id)}: the work is safe but its pull request is not open. ${c.blocker || ''} ${c.recovery || ''}`.trim() });
    if (c.status === 'unreached') out.push({ key: `unreached:${c.site_id}`, severity: SEVERITY.WARNING, siteId: c.site_id, message: `${name(c.site_id)} was not reached today. ${c.blocker || ''}`.trim() });
    if (c.stages?.closed?.forced) out.push({ key: `in-flight-at-close:${c.site_id}`, severity: SEVERITY.WARNING, siteId: c.site_id, message: `${name(c.site_id)} was still shipping when the day was closed; check its pull request.` });
  }
  for (const l of locks) {
    const heldMs = nowMs - new Date(l.acquired_at).getTime();
    const expired = l.expires_at && new Date(l.expires_at).getTime() < nowMs;
    if (!expired && heldMs > HUNG_LOCK_HOURS * 3_600_000) out.push({ key: `hung-lock:${l.job_key}`, severity: SEVERITY.WARNING, siteId: null, message: `Job "${l.job_key}" has held its lock for ${Math.round(heldMs / 3_600_000 * 10) / 10} hours.` });
  }
  for (const d of mergedByBot) out.push({ key: `merged-by-bot:${d.site_id}:${d.pr_number}`, severity: SEVERITY.CRITICAL, siteId: d.site_id, message: `${name(d.site_id)} PR #${d.pr_number} was merged by "${d.merged_by}" (${d.merged_by_type}), not a person. This system never merges; find out who or what did.` });
  for (const d of mergedUnverified) out.push({ key: `merged-unverified:${d.site_id}:${d.pr_number}`, severity: SEVERITY.WARNING, siteId: d.site_id, message: `${name(d.site_id)} PR #${d.pr_number} was merged by ${d.merged_by || 'a person'} but the change is not confirmed on the live page.` });
  const inWindow = minute >= SESSION_START_MINUTE && minute < SESSION_CUTOFF_MINUTE;
  const off = skippedTicks.filter((t) => t.why === 'worker-offline').reduce((m, t) => Math.max(m, (new Date(t.lastAt).getTime() - new Date(t.firstAt).getTime()) / 60_000), 0);
  if (inWindow && off >= WORKER_OFFLINE_MIN) out.push({ key: 'worker-offline', severity: SEVERITY.HIGH, siteId: null, message: `The laptop worker has not been connected for ${Math.round(off)} minutes of the working window; no fixes are being written.` });
  return out;
}

/** Pure. Alerts not yet stated today (`alreadySent` is the set of keys already sent for this day). */
export const newAlerts = (alerts, alreadySent = new Set()) => alerts.filter((a) => !alreadySent.has(a.key));
