// THE ATOMIC DAILY CEILING.
//
// "Read today's count, then act" has a window between the read and the act. Two runs (the scheduled one and its catch-up,
// two processes, a retry) can both read 99 and both ship, ending at 101. A slot is therefore TAKEN, not checked: one
// UPDATE ... WHERE used < cap, which the database serialises per row. Of N simultaneous takers at most (cap - used)
// succeed, whatever the interleaving.
//
// One counter per (site, local day) covers every autonomous source, because every producer reaches it through one of two
// doors: createDraft() (auto-remediation, analyst-keyword-gap, learned-repair, design-agent) and the file-edits drain in
// auto-remediation (content-repair, template-capability-repair).
//
// cap = min(platform hard ceiling, the site's effective daily limit). The limit is read here, not passed in, so a producer
// that knows nothing about Surge Mode is still held to the same number as the lane sizing (laneBudgets).
//
// A slot is spent when WORK is started, not when it succeeds (drafts count whatever their outcome, see drafts.js), so it
// is given back only when the work provably never existed: the insert failed, or the file-edit push failed and the item
// returns to the queue. A crash between taking and using a slot loses that slot for the day; that is the safe direction.
import { query } from '../db.js';
import { HARD_CEILING, AUTONOMOUS_DRAFT_SOURCES } from '../lib/autonomous-quota.js';
import { surgeStatus, effectiveSiteLimit } from '../lib/surge-mode.js';
import { safeTimezone } from '../util/dates.js';

export class AutonomousCeilingError extends Error {
  constructor(siteId, used, cap) {
    super(`autonomous daily ceiling reached for site ${siteId} (${used}/${cap})`);
    this.name = 'AutonomousCeilingError';
    this.code = 'AUTONOMOUS_CEILING';
    this.reason = 'daily-ceiling';
    this.siteId = siteId;
    this.used = used;
    this.cap = cap;
  }
}
export const isCeilingError = (err) => err?.code === 'AUTONOMOUS_CEILING';
export const isAutonomousSource = (source) => AUTONOMOUS_DRAFT_SOURCES.includes(source);

// The day's real cap for this site, and the site's local day.
async function loadCap(siteId, { now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT timezone, auto_remediation_daily_limit AS lim, surge_mode_until FROM sites WHERE id = $1`, [siteId]);
  if (!rows[0]) return null;
  const tz = safeTimezone(rows[0].timezone);
  const limit = effectiveSiteLimit(rows[0].lim, surgeStatus(rows[0].surge_mode_until, now));
  const cap = Math.max(0, limit == null ? HARD_CEILING : Math.min(Number(limit), HARD_CEILING));
  return { tz, cap };
}

// First touch of a day seeds the row with what was ALREADY spent today (drafts of every autonomous source plus shipped
// file-edits), so a deploy in the middle of a day does not hand out a second helping.
const SEED = `
  INSERT INTO autonomous_daily_slots (site_id, day, used)
  SELECT $1, (now() AT TIME ZONE $2)::date,
         (SELECT COUNT(*) FROM drafts
           WHERE site_id = $1 AND source = ANY($3)
             AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)
       + (SELECT COUNT(*) FROM shipping_queue
           WHERE site_id = $1 AND kind = 'file-edits' AND state = 'shipped' AND shipped_at IS NOT NULL
             AND (shipped_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)
  ON CONFLICT (site_id, day) DO NOTHING`;

/** Take one slot. Throws AutonomousCeilingError when none is left. Returns { used, cap, day }. */
export async function takeSlot(siteId, { now = new Date() } = {}) {
  const c = await loadCap(siteId, { now });
  if (!c) return { used: 0, cap: HARD_CEILING, day: null, untracked: true }; // no such site: the FK-bound caller fails on its own
  await query(SEED, [siteId, c.tz, AUTONOMOUS_DRAFT_SOURCES]);
  const { rows } = await query(
    `UPDATE autonomous_daily_slots SET used = used + 1, updated_at = now()
      WHERE site_id = $1 AND day = (now() AT TIME ZONE $2)::date AND used < $3
      RETURNING used, day`, [siteId, c.tz, c.cap]);
  if (rows[0]) return { used: rows[0].used, cap: c.cap, day: rows[0].day };
  const { rows: cur } = await query(
    `SELECT used FROM autonomous_daily_slots WHERE site_id = $1 AND day = (now() AT TIME ZONE $2)::date`, [siteId, c.tz]);
  throw new AutonomousCeilingError(siteId, cur[0]?.used ?? c.cap, c.cap);
}

/** Give a slot back: only for work that provably never existed. Never goes below zero. */
export async function giveBackSlot(siteId, { now = new Date() } = {}) {
  const c = await loadCap(siteId, { now });
  if (!c) return;
  await query(
    `UPDATE autonomous_daily_slots SET used = GREATEST(0, used - 1), updated_at = now()
      WHERE site_id = $1 AND day = (now() AT TIME ZONE $2)::date`, [siteId, c.tz]).catch(() => {});
}

/** Read-only view for status and logs. */
export async function slotsUsedToday(siteId, { now = new Date() } = {}) {
  const c = await loadCap(siteId, { now });
  if (!c) return { used: 0, cap: 0 };
  const { rows } = await query(
    `SELECT used FROM autonomous_daily_slots WHERE site_id = $1 AND day = (now() AT TIME ZONE $2)::date`, [siteId, c.tz]);
  return { used: rows[0]?.used ?? null, cap: c.cap };
}
