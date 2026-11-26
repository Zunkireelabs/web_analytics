// THE DAY'S RECORD FOR EVERY PROJECT (migrations 268 delivery_cycles, 269 delivery_items).
//
// Rule this file exists to keep: a project cannot disappear from a day. Every active project ends every working day with exactly one
// closed delivery_cycles row saying one of: delivered (a PR is open), preserved (validated work is stored, the PR could not be opened,
// here is why and how to finish it), no-work (nothing eligible, and why), incomplete (eligible work remained, and why), or unreached
// (the day closed before this project's turn). The deciding logic is PURE (decideClosure), so every case is tested without a database;
// the database half takes its query function as a parameter so it can be tested the same way.
//
// Nothing here is read by the shipping path, and nothing here may break it: the hooks that feed it (recordRunIntoCycle,
// recordItemOutcome) swallow their own errors, like the run log they sit next to.
import { query as defaultQuery } from '../db.js';
import { deliveryRecordMode } from './delivery-modes.js';

export const CYCLE_STATUS = Object.freeze({
  OPEN: 'open', DELIVERED: 'delivered', PRESERVED: 'preserved', NO_WORK: 'no-work', INCOMPLETE: 'incomplete', UNREACHED: 'unreached',
});
export const CLOSED_STATUSES = new Set(['delivered', 'preserved', 'no-work', 'incomplete', 'unreached']);

/** The working day, as YYYY-MM-DD, in the given IANA time zone (the worker's: the 5 PM deadline is a Nepal clock, not the server's). */
export function cycleDateIn(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// How an attempt's outcome and retry policy become an item's state. A 'failed' attempt is "blocked"; whether trying again can help is
// carried by retry_policy, never inferred from the state name.
export function itemStateFor({ outcome, retryPolicy = null }) {
  if (outcome === 'shipped') return 'shipped';
  if (outcome === 'superseded') return 'skipped';
  if (outcome === 'returned') return 'skipped';
  if (outcome === 'failed') return retryPolicy === 'already_resolved' ? 'skipped' : 'blocked';
  return 'selected';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function topKinds(items, limit = 3) {
  const counts = new Map();
  for (const it of items) {
    if (it.state !== 'blocked' && it.state !== 'refused') continue;
    const key = it.blocked_kind || 'unclassified';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => `${k} (${n})`);
}

/**
 * Pure. Decide how a project's day ends, from what the passes recorded. Never returns "open": closing always says something.
 *   cycle     the delivery_cycles row (or null when no pass ever recorded one: the project was never reached)
 *   items     that cycle's delivery_items rows
 *   evidence  { pushedBranch, openedPrUrl } a branch holding pushed work that has no pull request, and/or a PR opened today (both from drafts)
 *   lastSkip  the last reason a pass skipped this project (e.g. 'window-closed'), if any
 *   eligibleRemaining  how many eligible items were still waiting when the day closed (null = unknown)
 * @returns {{status:string, blocker:string|null, recovery:string|null}}
 */
export function decideClosure({ cycle, items = [], evidence = {}, lastSkip = null, eligibleRemaining = null } = {}) {
  // A PR counts whether the pass that opened it recorded it on the cycle or a later pass / the PR poll did (evidence.openedPrUrl comes from drafts).
  if (cycle?.pr_url || evidence.openedPrUrl) return { status: CYCLE_STATUS.DELIVERED, blocker: null, recovery: null, prUrl: cycle?.pr_url || evidence.openedPrUrl };

  const shippedItems = items.filter((i) => i.state === 'shipped').length;
  if (evidence.pushedBranch || (cycle?.shipped || 0) > 0 || shippedItems > 0) {
    const branch = evidence.pushedBranch || cycle?.branch_name || null;
    const pd = evidence.preserved || null; // the consolidation step's record (lib/delivery-consolidation.js), when it ran
    return {
      status: CYCLE_STATUS.PRESERVED,
      blocker: pd ? `Validated changes were pushed but the pull request could not be opened: ${pd.exactError}` : 'Validated changes were pushed but no pull request was opened today.',
      recovery: pd
        ? `${pd.recovery.automatic} By hand: ${pd.recovery.byHand[0]}. ${pd.recovery.nothingLost}`
        : (branch ? `Open the pull request from branch "${branch}" (nothing was lost; the commits are on that branch).` : 'Find the shipped drafts of today in the Action Center and open their pull request.'),
    };
  }

  if (!cycle || (cycle.passes || 0) === 0) {
    const why = lastSkip ? `The day closed before this project was reached (${lastSkip}).` : 'No pass reached this project today (the worker was offline or no pass started).';
    return { status: CYCLE_STATUS.UNREACHED, blocker: why, recovery: 'It is first in line on the next pass. Check the worker session log for why no pass started.' };
  }

  const blockedItems = items.filter((i) => i.state === 'blocked' || i.state === 'refused');
  const waiting = typeof eligibleRemaining === 'number' ? eligibleRemaining : 0;
  if (blockedItems.length === 0 && waiting === 0 && (cycle.attempted || 0) === 0) {
    const skipped = cycle.skipped || 0;
    return {
      status: CYCLE_STATUS.NO_WORK,
      blocker: skipped > 0 ? `Nothing was eligible: ${plural(skipped, 'item')} held or paced, none ready to write.` : 'Nothing was eligible today: no open item was ready to write.',
      recovery: null,
    };
  }

  const kinds = topKinds(blockedItems);
  const parts = [];
  if (blockedItems.length) parts.push(`${plural(blockedItems.length, 'item')} blocked${kinds.length ? `: ${kinds.join(', ')}` : ''}`);
  if (waiting > 0) parts.push(`${plural(waiting, 'eligible item')} still waiting${lastSkip ? ` (${lastSkip})` : ''}`);
  return {
    status: CYCLE_STATUS.INCOMPLETE,
    blocker: parts.join('; ') || 'The day ended with work attempted and nothing shipped.',
    recovery: [
      blockedItems.length ? 'Blocked items keep their stored content and are listed on this record.' : null,
      waiting > 0 ? 'Waiting items are first in line on the next pass.' : null,
    ].filter(Boolean).join(' ') || 'Nothing shipped; see the attempts on this record.',
  };
}

// ───────────────────────── database side ─────────────────────────

/**
 * Today's batch branch for a project, the name implementers/lib/github-ops.js batchBranchName gives it: the day is the PROJECT's own calendar
 * day. A pull request belongs to today's delivery when its draft sits on this branch. (Not "recently updated": the hourly PR-status poll touches
 * every open draft, so an old PR looks fresh. The first replay of 2026-11-25 reported Admizz and Zennly as delivered because of exactly that.)
 */
export const batchBranchFor = (site, now = new Date()) => `action-center/batch-${site.id}-${cycleDateIn(site.timezone || 'UTC', now)}`;

/** The project's row for this working day, created if it is the first thing recorded today. */
export async function getOrOpenCycle(siteId, { timezone = 'Asia/Kathmandu', now = new Date(), query = defaultQuery } = {}) {
  const day = cycleDateIn(timezone, now);
  const { rows } = await query(
    `INSERT INTO delivery_cycles (site_id, cycle_date) VALUES ($1, $2)
     ON CONFLICT (site_id, cycle_date) DO UPDATE SET updated_at = delivery_cycles.updated_at
     RETURNING *`,
    [siteId, day]);
  return rows[0];
}

/**
 * Hook: called by recordAutoRemediationRun for EVERY run record (real runs and "skipped" ones alike), so the day record sees both.
 * Counts add up across the day's passes. Best effort; never throws.
 */
export async function recordRunIntoCycle(siteId, run, { timezone, now, query = defaultQuery } = {}) {
  if (deliveryRecordMode() === 'off') return null;
  try {
    const cycle = await getOrOpenCycle(siteId, { timezone, now, query });
    const skippedRun = run.selection?.runSkipped === true;
    const reached = !skippedRun;
    await query(
      `UPDATE delivery_cycles SET
         passes = passes + $2, attempted = attempted + $3, shipped = shipped + $4, blocked = blocked + $5, skipped = GREATEST(skipped, $6),
         pr_url = COALESCE($7, pr_url), last_pass_at = now(), updated_at = now(),
         stages = jsonb_set(stages, '{lastRun}', $8::jsonb, true)
       WHERE id = $1 AND closed_at IS NULL`,
      [cycle.id, reached ? 1 : 0, run.attempted || 0, run.shipped || 0, (run.failed || 0) + (run.refused || 0), run.skipped || 0, run.prUrl || null,
        JSON.stringify({ at: new Date(now || Date.now()).toISOString(), stoppedReason: run.stoppedReason || null, reached, attempted: run.attempted || 0, shipped: run.shipped || 0 })]);
    return cycle.id;
  } catch (err) {
    console.error('[delivery-cycle] could not record the run into the day record:', err.message);
    return null;
  }
}

/**
 * Hook: called by recordAttempt for every attempt, and by the shipping loop for items it skips for a reason worth keeping (design pending).
 * One row per recommendation per day; a retry the same day updates it and appends to its history. `skipReason` makes the item 'skipped'
 * (not started this time, nothing counted against it). Never throws.
 */
export async function recordItemOutcome(siteId, { recommendationId, findingId, draftId, outcome, failureClass, retryPolicy, reason, skipReason = null, generatorId = null, page = null }, { timezone, now, query = defaultQuery } = {}) {
  if (deliveryRecordMode() === 'off') return;
  try {
    const cycle = await getOrOpenCycle(siteId, { timezone, now, query });
    const state = skipReason ? 'skipped' : itemStateFor({ outcome, retryPolicy });
    const blocked = state === 'blocked';
    const entry = { at: new Date(now || Date.now()).toISOString(), outcome: skipReason ? 'skipped' : outcome, failureClass: failureClass ?? null, retryPolicy: retryPolicy ?? null, skipReason, reason: reason ? String(reason).slice(0, 300) : null };
    await query(
      `INSERT INTO delivery_items (cycle_id, site_id, recommendation_id, finding_id, draft_id, content_draft_id, generator_id, page, state, blocked_kind, blocked_reason, retry_policy, skip_reason, attempts, history)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13::jsonb)
       ON CONFLICT (cycle_id, recommendation_id) WHERE recommendation_id IS NOT NULL DO UPDATE SET
         state = EXCLUDED.state, draft_id = COALESCE(EXCLUDED.draft_id, delivery_items.draft_id),
         content_draft_id = COALESCE(EXCLUDED.content_draft_id, delivery_items.content_draft_id),
         generator_id = COALESCE(EXCLUDED.generator_id, delivery_items.generator_id), page = COALESCE(EXCLUDED.page, delivery_items.page),
         blocked_kind = EXCLUDED.blocked_kind, blocked_reason = EXCLUDED.blocked_reason, retry_policy = EXCLUDED.retry_policy, skip_reason = EXCLUDED.skip_reason,
         attempts = delivery_items.attempts + 1, history = delivery_items.history || EXCLUDED.history, updated_at = now()`,
      [cycle.id, siteId, recommendationId ?? null, findingId ?? null, draftId ?? null, generatorId, page, state,
        blocked ? (failureClass ?? null) : null, blocked ? entry.reason : null, retryPolicy ?? null, skipReason, JSON.stringify([entry])]);
  } catch (err) {
    console.error('[delivery-cycle] could not record the item outcome:', err.message);
  }
}

/**
 * The 17:00 closer. Makes sure EVERY given project has a closed row for today and says how the day ended. Idempotent (a closed row is
 * left as it is). One project failing to close never stops the others. Returns what it wrote, for the log and the tests.
 *   sites    the active projects (the caller decides who is active)
 *   eligibleFor(siteId) -> number|null   how many eligible items were still waiting (null when it cannot be known)
 */
export async function closeDeliveryDay({ sites, timezone = 'Asia/Kathmandu', now = new Date(), query = defaultQuery, eligibleFor = async () => null, isInFlight = async () => false, force = false } = {}) {
  const out = [];
  if (deliveryRecordMode() === 'off') return out;
  for (const site of sites) {
    try {
      const cycle = await getOrOpenCycle(site.id, { timezone, now, query });
      if (cycle.closed_at) { out.push({ siteId: site.id, status: cycle.status, already: true }); continue; }
      // A pass still running for this project is about to open its own PR: closing now would record "incomplete" for work that is minutes from done.
      // Deferred, not skipped: the close runs again every ten minutes, and `force` (the last run) closes whatever is left and says it was still in flight.
      const inFlight = !force && await isInFlight(site).catch(() => false);
      if (inFlight) { out.push({ siteId: site.id, status: 'deferred', why: 'a shipping pass is still running for this project' }); continue; }
      const { rows: items } = await query(`SELECT state, blocked_kind, retry_policy FROM delivery_items WHERE cycle_id = $1`, [cycle.id]);
      const todaysBranch = batchBranchFor(site, now);
      const { rows: pushed } = await query(
        `SELECT branch_name FROM drafts WHERE site_id = $1 AND status = 'branch_pushed' AND pr_number IS NULL AND branch_name = $2 LIMIT 1`, [site.id, todaysBranch]);
      const { rows: opened } = await query(
        `SELECT pr_url FROM drafts WHERE site_id = $1 AND pr_url IS NOT NULL AND pr_number IS NOT NULL AND branch_name = $2
            AND status IN ('pr_opened', 'awaiting_publish', 'implemented', 'merged_to_stage') LIMIT 1`, [site.id, todaysBranch]);
      const lastSkip = cycle.stages?.lastRun?.reached === false ? cycle.stages.lastRun.stoppedReason : null;
      const eligibleRemaining = await eligibleFor(site.id).catch(() => null);
      const verdict = decideClosure({ cycle, items, evidence: { pushedBranch: pushed[0]?.branch_name || null, openedPrUrl: opened[0]?.pr_url || null, preserved: cycle.stages?.delivery || null }, lastSkip, eligibleRemaining });
      await query(
        `UPDATE delivery_cycles SET status = $2, blocker = $3, recovery = $4, branch_name = COALESCE($5, branch_name), pr_url = COALESCE($7, pr_url), closed_at = now(), updated_at = now(),
                stages = jsonb_set(stages, '{closed}', $6::jsonb, true)
          WHERE id = $1 AND closed_at IS NULL`,
        [cycle.id, verdict.status, verdict.blocker, verdict.recovery, pushed[0]?.branch_name || null, JSON.stringify({ at: new Date(now).toISOString(), eligibleRemaining, forced: force && (await isInFlight(site).catch(() => false)) }), verdict.prUrl || null]);
      out.push({ siteId: site.id, ...verdict });
    } catch (err) {
      // The one rule that must hold even when closing fails: say so, loudly, and keep going with the other projects.
      console.error(`[delivery-cycle] could not close site ${site.id}'s day:`, err.message);
      out.push({ siteId: site.id, status: 'failed-to-close', error: err.message });
    }
  }
  return out;
}
