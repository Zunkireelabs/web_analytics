// Converges the Action Center onto the truth: every recommendation whose
// attempt has stopped moving comes back to the board, exactly once, on the
// row it already had.
//
// The gap this closes. getDraftedFindingIds (store/drafts.js) hides a
// recommendation the moment any of its findings has a non-abandoned draft.
// That is right while the draft is actually moving, and becomes a permanent
// disappearance the moment it stops: a draft stuck at 'approved' with no
// branch, or at 'branch_pushed' on a batch branch whose shared PR never
// opened, hides its recommendation forever. Nothing in the system reclaims
// it. Measured on site 1 on 2026-09-03, before this existed: 42 drafts stuck
// at branch_pushed on a 3-day-old batch branch, 11 approved and never pushed
// (oldest 10 days), 1 submitted_for_approval for 4 days — 48 open
// recommendations invisible to the user, reading as "my site is healthy".
//
// The two recovery scripts that already existed for this
// (scripts/recover-stranded-unattended-drafts.js,
// scripts/recover-quality-gate-stuck-drafts.js) each fixed one snapshot of
// one cause, by hand, on demand. Neither is scheduled. This runs hourly for
// every site and is cause-agnostic: it reclaims on lack of progress, not on
// recognising a particular way of getting stuck, so the next new way of
// getting stuck is covered the day it appears rather than after someone
// notices 40 missing cards.
//
// What it deliberately does NOT do:
//   - It never creates a recommendation. It reopens the row that already
//     exists (store/recommendations.js's reopenRecommendation). A reclaimed
//     attempt must not produce a second card for an issue the user has
//     already seen — that is the duplication this whole change exists to end.
//   - It never touches a human-owned draft (submitted_for_approval,
//     revision_requested). Those are waiting on a person, not stalled;
//     lib/draft-ship-state.js already treats them as untouchable and the
//     lifecycle derivation surfaces them as 'blocked' so they are visible
//     rather than reclaimed out from under the reviewer.
//   - It never asks GitHub anything. PR truth already has an owner —
//     checkDraftPrStatus, driven by the webhook and the :20 hourly poll. A
//     second poller would double the API spend against the same rate limit
//     that already abandoned 113 drafts in one hour on 2026-09-01.
import { query } from '../db.js';
import { markDraftAbandoned } from '../store/drafts.js';
import { reopenRecommendation, blockRecommendation, closeRecommendation } from '../store/recommendations.js';
import { recordAttempt } from '../store/recommendation-attempts.js';
import { classifyAbandonReason, RETRY_POLICY } from './attempt-classification.js';

// How long a draft may sit without progress before its recommendation is
// taken back. Long enough that nothing in flight is disturbed — a normal
// ship completes in minutes, and the daily batch closes the same day — short
// enough that a stall surfaces the next morning rather than next week.
export const IDLE_RECLAIM_HOURS = 24;

// States a stalled draft can be reclaimed FROM. Everything here is a state
// the system itself is responsible for advancing, so no progress means the
// system dropped it.
const RECLAIMABLE_STATUSES = ['draft', 'edited', 'approved', 'branch_pushed'];

// The abandon reason written on reclaim. An exact sentinel, not prose, and
// already present in countFailedAttemptsByFinding's excluded IN clause
// (store/drafts.js) — a reclaim is bookkeeping, not a verdict on the item,
// and must never count against it. Until now nothing in the codebase ever
// wrote this string; it existed only in that exclusion list.
const RECLAIM_REASON = 'sent_back_to_recommendations';

// Finds the recommendation a draft belongs to. Prefers a currently-open row,
// then the most recent — a finding can appear on a closed row and a newer
// open one if the issue was detected again after being closed, and the live
// card is the one that should carry the attempt.
async function findRecommendationForFinding(siteId, findingId) {
  if (!findingId) return null;
  const { rows } = await query(
    `SELECT id, status, blocked_reason FROM recommendations
      WHERE site_id = $1 AND $2 = ANY(finding_ids)
      ORDER BY (status = 'open') DESC, updated_at DESC
      LIMIT 1`,
    [siteId, findingId],
  );
  return rows[0] || null;
}

// Pass 1 — drafts that stopped moving. Reclaim them and hand the
// recommendation back.
async function reclaimStalledDrafts(siteId, { idleHours, apply, log }) {
  const { rows: stalled } = await query(
    `SELECT id, finding_id, status, action_type, branch_name, updated_at
       FROM drafts
      WHERE site_id = $1
        AND status = ANY($2)
        AND pr_number IS NULL
        AND updated_at < now() - ($3 || ' hours')::interval
      ORDER BY updated_at ASC`,
    [siteId, RECLAIMABLE_STATUSES, String(idleHours)],
  );

  const result = { reclaimed: 0, reopened: 0, conflicts: 0, drafts: [] };
  for (const draft of stalled) {
    result.drafts.push({ id: draft.id, status: draft.status, actionType: draft.action_type });
    if (!apply) continue;

    const rec = await findRecommendationForFinding(siteId, draft.finding_id);
    // Abandon first, then reopen. In that order a crash between the two
    // leaves the draft abandoned and the recommendation merely still-closed,
    // which the NEXT run's pass 2 picks up and finishes. The reverse order
    // would leave a recommendation open while its draft still hides it —
    // visible-but-unactionable, the worse of the two failure modes.
    const abandoned = await markDraftAbandoned(siteId, draft.id, RECLAIM_REASON);
    // markDraftAbandoned is guarded (never overwrites implemented/abandoned).
    // A null means the row moved between the SELECT and here — a real ship
    // finishing concurrently — so leave the recommendation alone.
    if (!abandoned) continue;
    result.reclaimed += 1;

    await recordAttempt(siteId, {
      recommendationId: rec?.id ?? null,
      findingId: draft.finding_id,
      draftId: draft.id,
      outcome: 'returned',
      // Explicitly RETRY rather than letting the sentinel classify itself.
      // A stall says nothing bad about the item — it was never actually
      // tried on its merits — so the next pass should pick it up normally.
      retryPolicy: RETRY_POLICY.RETRY,
      reason: `Stalled at "${draft.status}" for over ${idleHours}h with no pull request, and was returned for another attempt.`,
    });

    if (rec) {
      const { reopened, conflictId } = await reopenRecommendation(rec.id);
      if (reopened) result.reopened += 1;
      else {
        result.conflicts += 1;
        log?.(`[reconciler] site ${siteId}: rec ${rec.id} stayed closed; open row ${conflictId} already covers it`);
      }
    }
  }
  return result;
}

// Pass 2 — attempts that ended in a real failure and were never classified.
// Every abandoned draft inside the convergence cap's own 30-day window that
// has no attempt row yet gets one, and the policy that falls out of it is
// applied to the recommendation.
//
// This doubles as the backfill for history that predates migration 139: the
// classification is derived from the reason already stored on the draft, so
// existing rows get the same treatment new ones will, without a separate
// one-shot script that someone has to remember to run (the failure mode of
// both existing recovery scripts).
async function classifyUnrecordedFailures(siteId, { apply, log }) {
  const { rows: unrecorded } = await query(
    `SELECT d.id, d.finding_id, d.abandoned_reason, d.abandoned_at
       FROM drafts d
      WHERE d.site_id = $1
        AND d.status = 'abandoned'
        AND d.finding_id IS NOT NULL
        AND d.abandoned_reason IS NOT NULL
        AND d.abandoned_at > now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM recommendation_attempts a
           WHERE a.site_id = d.site_id AND a.draft_id = d.id
        )
      ORDER BY d.abandoned_at ASC`,
    [siteId],
  );

  const result = { classified: 0, blocked: 0, resolved: 0, returned: 0, byPolicy: {} };
  for (const draft of unrecorded) {
    const { failureClass, retryPolicy, summary } = classifyAbandonReason(draft.abandoned_reason);
    result.byPolicy[retryPolicy] = (result.byPolicy[retryPolicy] || 0) + 1;
    if (!apply) continue;

    const rec = await findRecommendationForFinding(siteId, draft.finding_id);
    await recordAttempt(siteId, {
      recommendationId: rec?.id ?? null,
      findingId: draft.finding_id,
      draftId: draft.id,
      outcome: 'failed',
      failureClass,
      retryPolicy,
      reason: draft.abandoned_reason,
    });
    result.classified += 1;
    if (!rec) continue;

    // Act on the verdict. Only these two policies change the recommendation:
    // everything else leaves it exactly where it is, because "try again" and
    // "a human closed the PR" are both already correctly represented by an
    // open card with its attempt history attached.
    if (retryPolicy === RETRY_POLICY.ALREADY_RESOLVED) {
      // Another change fixed the underlying issue first. Closing as
      // superseded (not unfixable) is the honest word for it — the issue IS
      // resolved — and it frees the dedup key, so a genuine regression later
      // opens a fresh row rather than being blocked by this one.
      if (rec.status === 'open') {
        await closeRecommendation(rec.id);
        result.resolved += 1;
        log?.(`[reconciler] site ${siteId}: rec ${rec.id} closed — already resolved elsewhere`);
      }
    } else if (retryPolicy === RETRY_POLICY.NEEDS_HUMAN) {
      // Stays open and visible, with the reason on the card, and out of the
      // unattended path until the config lands. Only set it if it isn't
      // already blocked, so a more specific existing reason isn't overwritten
      // by this generic one.
      if (rec.status === 'open' && !rec.blocked_reason) {
        await blockRecommendation(rec.id, summary);
        result.blocked += 1;
      }
    }
  }
  return result;
}

// Reconciles one site. `apply: false` makes it a pure dry run — it reports
// exactly what it would do and writes nothing, which is how this gets
// verified against production data before being trusted to run unattended.
export async function reconcileSite(siteId, { idleHours = IDLE_RECLAIM_HOURS, apply = true, log = console.log } = {}) {
  const stalled = await reclaimStalledDrafts(siteId, { idleHours, apply, log });
  const failures = await classifyUnrecordedFailures(siteId, { apply, log });
  return { siteId, stalled, failures };
}

// Every site, one at a time. Sequential on purpose: this shares a connection
// pool with the request path and with the agent battery, and a fan-out over
// every site buys nothing here — the work is small per site and never
// latency-critical.
export async function reconcileAllSites({ idleHours = IDLE_RECLAIM_HOURS, apply = true, log = console.log } = {}) {
  const { rows: sites } = await query('SELECT id FROM sites ORDER BY id');
  const results = [];
  for (const site of sites) {
    try {
      results.push(await reconcileSite(site.id, { idleHours, apply, log }));
    } catch (err) {
      // One site's failure must not stop the sweep for every other site —
      // this is a multi-tenant janitor, and a single tenant's bad row
      // silently costing every other tenant their reconciliation is exactly
      // the shape of outage this file exists to prevent.
      log?.(`[reconciler] site ${site.id} failed: ${err.message}`);
    }
  }
  const totals = results.reduce((acc, r) => ({
    reclaimed: acc.reclaimed + r.stalled.reclaimed,
    reopened: acc.reopened + r.stalled.reopened,
    classified: acc.classified + r.failures.classified,
    blocked: acc.blocked + r.failures.blocked,
    resolved: acc.resolved + r.failures.resolved,
  }), { reclaimed: 0, reopened: 0, classified: 0, blocked: 0, resolved: 0 });
  return { results, totals };
}
