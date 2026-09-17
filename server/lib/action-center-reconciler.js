// Converges the Action Center onto the truth: every recommendation whose
// attempt has stopped moving comes back to the board, exactly once, on the
// row it already had — and, since 2026-09-06 (pass 4, driveAutonomousRecovery
// below), every recommendation whose attempts ARE still moving but can only
// ever reach the same per-item failure gets RE-ANALYZED against live content
// and retried on fresh evidence, a bounded number of times, before it is
// ever handed to a human as the last resort rather than the default answer.
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
//   - It never POLLS GitHub for PR truth. That already has an owner —
//     checkDraftPrStatus, driven by the webhook and the :20 hourly poll. A
//     second poller would double the API spend against the same rate limit
//     that already abandoned 113 drafts in one hour on 2026-09-01.
//     Pass 0 (recoverUnopenedBatchPrs, added 2026-09-08) is the one deliberate
//     exception and is not a poller: it reads a branch only when this site
//     actually holds drafts stuck at 'branch_pushed' with no PR — i.e. only
//     when there is specific work to finish — and it asks the one question no
//     existing owner answers, "are these commits really on GitHub?", because
//     the alternative was throwing away pushed work on a guess. It skips
//     itself entirely while the credential's budget is low, so it can never
//     be the thing that exhausts it.
import { query } from '../db.js';
import { markDraftAbandoned, countFailedAttemptsByFinding, getDraftByFindingId } from '../store/drafts.js';
import { reopenRecommendation, blockRecommendation, closeRecommendation, listOpenRecommendations } from '../store/recommendations.js';
import { recordAttempt, countRecoveryCyclesByFinding, countRefusalRecoveryCyclesByRecommendation } from '../store/recommendation-attempts.js';
import { countRefusalsByRecommendation } from '../agents/lib/generator-learning.js';
import { getSiteById } from '../store/read.js';
import { classifyAbandonReason, RETRY_POLICY } from './attempt-classification.js';
import { logInternal } from './errors.js';
// Reused rather than re-defined: one formula decides both "stop auto-drafting
// this" (ship-pacing's applyConvergenceCap, wired into both unattended ship
// paths) and "stop retrying this approach and try a different one" (the
// autonomous-recovery pass below) — the same question asked from two call
// sites must get the same answer, or one silently excludes a finding the
// other still considers eligible.
import { MAX_RECOVERY_CYCLES, effectiveConvergenceCap, MAX_REFUSAL_RECOVERY_CYCLES, effectiveRefusalCap } from '../agents/lib/ship-pacing.js';
// recheckRecommendation is the ONE existing entry point that re-runs a
// finding's detecting agent against LIVE content for a single recommendation
// (originally built for the manual "Re-check now" button) — reused here with
// its refreshEvidence option rather than duplicating re-detection logic. See
// its own doc comment in recommendation-coordinator.js for why this, and not
// a second live-content reader, is the right thing to call from here.
import { recheckRecommendation } from '../agents/lib/recommendation-coordinator.js';
import { verifyRecommendation, VERIFICATION_DECISION } from '../generators/lib/verification-layer.js';
import { getGenerator } from '../generators/registry.js';
import { recoverUnopenedBatchPrs } from './batch-pr-recovery.js';

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

// Pass 1 — ITEM_DEFECT drafts stuck at 'approved' with a failed apply. Must
// run BEFORE pass 2 (stall reclaim): a draft in this state that pass 2 would
// otherwise reclaim after IDLE_RECLAIM_HOURS gets abandoned with the
// generic, UNCOUNTED 'sent_back_to_recommendations' reason — erasing the one
// piece of evidence (the real apply_error) that says this is a per-item
// defect, not a stall. Left running second, the reconciler could cycle a
// genuinely broken item through pass 2 forever without the convergence cap
// ever seeing a countable failure.
//
// Reaching 'approved' with apply_error set at all is narrow: both unattended
// ship paths (auto-remediation.js's shipDraftForRecommendation,
// routes/action-center.js's executeRecommendation) wrap their first
// approve+push attempt in approveAndPublishDraftUnattended, which abandons
// the draft immediately on ANY failure — so a first-time failure never rests
// here. It's the RESUME_APPLY retry of an already-'approved' draft (a
// second, independent apply attempt, called via pushDraftBranch directly)
// that leaves this state if it fails again: recordApplyFailure records the
// error and leaves status alone, and neither caller's outer catch abandons
// the draft on this path — only the stall reclaim would, eventually, without
// this pass running first.
//
// This pass makes exactly ONE decision — record + abandon — and deliberately
// does NOT also decide recover-vs-block. That decision needs the site-wide
// picture (every open recommendation's cumulative attempts and recovery
// cycles), which driveAutonomousRecovery (below, after pass 3) already
// computes once for the whole site; duplicating a second, narrower version
// of that same threshold logic here is exactly the "two things deciding the
// same question" shape this whole file exists to avoid. Abandoning is enough
// on its own to unblock regeneration — it frees getDraftByFindingId's
// idempotency check for the next attempt — so this pass's job ends there.
async function reconcileStuckApprovedDrafts(siteId, { apply, log }) {
  const { rows: stuck } = await query(
    `SELECT id, finding_id, apply_error
       FROM drafts
      WHERE site_id = $1 AND status = 'approved' AND apply_error IS NOT NULL AND finding_id IS NOT NULL`,
    [siteId],
  );

  const result = { abandoned: 0, drafts: [] };
  if (stuck.length === 0) return result;

  for (const draft of stuck) {
    const classified = classifyAbandonReason(draft.apply_error);
    // Not our concern: a RETRY/NEEDS_HUMAN/ALREADY_RESOLVED apply_error
    // reaching 'approved' is already handled correctly by leaving it
    // retryable in place — only a genuine per-item defect self-perpetuates
    // through blind retry.
    if (classified.retryPolicy !== RETRY_POLICY.ITEM_DEFECT) continue;

    const rec = await findRecommendationForFinding(siteId, draft.finding_id);
    if (!rec || rec.status !== 'open') continue;

    result.drafts.push({ id: draft.id, findingId: draft.finding_id, recommendationId: rec.id });
    if (!apply) continue;

    // Record first, abandon second — same ordering as pass 2/3: a crash
    // between the two leaves an unrecorded abandon that pass 3 below will
    // classify and act on next run, never a recorded attempt for a draft
    // that turns out to still be live.
    await recordAttempt(siteId, {
      recommendationId: rec.id,
      findingId: draft.finding_id,
      draftId: draft.id,
      outcome: 'failed',
      failureClass: classified.failureClass,
      retryPolicy: classified.retryPolicy,
      reason: draft.apply_error,
    });

    // Abandoning is what actually enables regeneration: getDraftByFindingId
    // (generateDraft's idempotency check) excludes abandoned drafts, so the
    // next time this recommendation is drafted — automatically next run, or
    // by a human clicking Generate Draft — it builds fresh content against
    // whatever the page looks like now, instead of returning this same
    // stale draft again.
    const abandoned = await markDraftAbandoned(siteId, draft.id, draft.apply_error, null);
    // A null means a concurrent ship moved the draft between the SELECT and
    // here (it actually succeeded, or a human is now reviewing it) — the
    // attempt row above is still accurate history, but there is nothing
    // stale left to regenerate.
    if (!abandoned) continue;
    result.abandoned += 1;
    log?.(`[reconciler] site ${siteId}: rec ${rec.id} draft ${draft.id} abandoned so a fresh attempt can be generated`);
  }
  return result;
}

// Pass 2 — drafts that stopped moving. Reclaim them and hand the
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
    // which the NEXT run's pass 3 picks up and finishes. The reverse order
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

// Pass 3 — attempts that ended in a real failure and were never classified.
// Every abandoned draft inside the convergence cap's own 30-day window that
// has no attempt row yet gets one, and the policy that falls out of it is
// applied to the recommendation.
//
// This doubles as the backfill for history that predates migration 139: the
// classification is derived from the reason already stored on the draft, so
// existing rows get the same treatment new ones will, without a separate
// one-shot script that someone has to remember to run (the failure mode of
// both existing recovery scripts).
//
// ITEM_DEFECT is deliberately NOT acted on here — only ALREADY_RESOLVED and
// NEEDS_HUMAN change the recommendation in this pass. Recording the attempt
// (above the if) is enough: it's what makes the finding's history visible to
// driveAutonomousRecovery (below), which is the ONE place that decides what
// happens once a finding has failed enough — recover or, only once recovery
// is exhausted, block. Deciding that here too, on top of a narrower slice of
// the same data (only unrecorded rows), is exactly the duplicate-decision
// shape this file exists to avoid.
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
  if (unrecorded.length === 0) return result;

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
    if (!rec || rec.status !== 'open') continue;

    if (retryPolicy === RETRY_POLICY.ALREADY_RESOLVED) {
      // Another change fixed the underlying issue first. Closing as
      // superseded (not unfixable) is the honest word for it — the issue IS
      // resolved — and it frees the dedup key, so a genuine regression later
      // opens a fresh row rather than being blocked by this one.
      await closeRecommendation(rec.id);
      result.resolved += 1;
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} closed — already resolved elsewhere`);
    } else if (retryPolicy === RETRY_POLICY.NEEDS_HUMAN) {
      // Stays open and visible, with the reason on the card, and out of the
      // unattended path until the config lands. Only set it if it isn't
      // already blocked, so a more specific existing reason isn't overwritten
      // by this generic one.
      if (!rec.blocked_reason) {
        await blockRecommendation(rec.id, summary);
        result.blocked += 1;
      }
    }
  }
  return result;
}

// Pass 4 — autonomous recovery for open recommendations already past the
// convergence cap. This is where the live 71-recommendation bug actually
// was: classifyUnrecordedFailures above only ever looks at abandoned drafts
// with NO recommendation_attempts row yet, and on site 1 every one of these
// findings' attempts was ALREADY recorded at failure time
// (routes/action-center.js's executeRecommendation and auto-remediation.js
// both call recordAttempt directly in their own catch blocks) — so pass 3's
// backfill query found nothing to do, ever, for these. Nothing else in the
// system re-checks an already-fully-recorded finding against the cap.
//
// The first version of this fix (2026-09-06, earlier the same day) blocked
// the recommendation for a human the moment it crossed MAX_FAILED_ATTEMPTS.
// That is not what an autonomous system should default to: 3 identical
// failures only prove that RETRYING THE SAME PARAMS doesn't converge — they
// say nothing about whether the underlying issue is fixable. The generated
// draft was built from `rec.params`, captured whenever this finding was
// first detected, and shipRecommendation/shipDraftForRecommendation both
// always draft against `rec.params` again on every subsequent attempt
// (routes/action-center.js) — nothing before this ever re-derived it from
// what the page looks like NOW, so every retry reproduced the identical
// stale anchor/target by construction.
//
// So: crossing the cap now triggers autonomous recovery instead of an
// immediate block. Recovery reuses recheckRecommendation's existing
// live-re-detection primitive (refreshEvidence: true) — the SAME one behind
// the manual "Re-check now" button — rather than a second implementation:
//   - the finding is no longer detected -> recheckRecommendation itself
//     already closes the recommendation as resolved. Nothing left to do.
//   - the finding is still real, with fresh params -> those params are
//     merged onto the recommendation (mergeIntoRecommendation, preserving its
//     finding_ids/identity exactly — see recheckRecommendation's own doc
//     comment), any live draft for the finding is abandoned so it can't be
//     returned again by generateDraft's idempotency check, and a 'recovered'
//     outcome is recorded (migration 142) — a fact distinct from 'failed',
//     so ship-pacing's effectiveConvergenceCap grants this finding another
//     full MAX_FAILED_ATTEMPTS on this fresh evidence, and driveAutonomousRecovery
//     won't reconsider it again until THOSE are also exhausted.
// Only once MAX_RECOVERY_CYCLES worth of these have already happened — the
// system re-detected, refreshed evidence, and tried again, repeatedly, and
// it's STILL hitting the identical class of failure — does this fall back to
// blockRecommendation. That is the true "cannot safely determine or validate
// a fix autonomously" exit, not the first stall.
//
// Idempotent by construction: recovering abandons the stale draft and
// refreshes params but never closes or re-opens the recommendation (it was
// already open), so re-running this hourly is a no-op until MAX_FAILED_ATTEMPTS
// more genuine failures accumulate against the newly-refreshed params —
// exactly the gap between recovery cycles, not a tight retry loop. Blocking
// is guarded the same way as pass 3 (`status = 'open'` in SQL,
// `!rec.blocked_reason` here), so a card already blocked is never reprocessed.
async function driveAutonomousRecovery(siteId, { apply, log }) {
  const counts = await countFailedAttemptsByFinding(siteId);
  const result = { recovered: 0, resolved: 0, blocked: 0, recommendations: [] };
  if (counts.size === 0) return result;

  // One count per finding for the whole pass, same shape as `counts` above —
  // this IS the number of times autonomous recovery has already been used,
  // which is what raises (or, once spent, stops raising) the effective cap.
  const recoveries = await countRecoveryCyclesByFinding(siteId);

  const openRecs = await listOpenRecommendations(siteId);
  for (const rec of openRecs) {
    if (rec.blocked_reason) continue;
    const findingIds = rec.finding_ids || [];
    const attempts = findingIds.reduce((max, id) => Math.max(max, counts.get(id) || 0), 0);
    const cycles = findingIds.reduce((max, id) => Math.max(max, recoveries.get(id) || 0), 0);
    if (attempts < effectiveConvergenceCap(cycles)) continue;

    result.recommendations.push({ id: rec.id, findingIds, attempts, cycles });
    if (!apply) continue;

    if (cycles >= MAX_RECOVERY_CYCLES) {
      // Genuinely exhausted: MAX_RECOVERY_CYCLES independent, freshly
      // re-detected attempts all converged on the same class of failure.
      // This is the true last resort, not the default.
      if (!rec.blocked_reason) {
        await blockRecommendation(
          rec.id,
          `This fix has failed ${attempts} times across ${cycles} autonomous re-analysis attempts, each against freshly re-checked content. It needs a human to look at it directly.`,
        );
        result.blocked += 1;
        log?.(`[reconciler] site ${siteId}: rec ${rec.id} blocked — ${cycles} recovery cycles exhausted, ${attempts} total attempts`);
      }
      continue;
    }

    let recheck;
    try {
      recheck = await recheckRecommendation(siteId, rec.id, { refreshEvidence: true });
    } catch (err) {
      // Re-detection itself failed (a transient API error, a page fetch
      // timeout) — this is not evidence about the finding, so it must not
      // consume a recovery cycle. Leave it exactly as it was; the next
      // hourly pass tries again.
      const id = logInternal(`action-center-reconciler recovery site ${siteId} rec ${rec.id}`, err);
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} recovery re-detection failed (ref: ${id}) — will retry next run`);
      continue;
    }

    if (recheck.status === 'superseded') {
      // recheckRecommendation already closed it — the issue resolved itself
      // between the last failed attempt and now. Nothing autonomous to fix.
      result.resolved += 1;
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} resolved on re-check — closed, no longer needs a fix`);
      continue;
    }
    if (!recheck.refreshed && !recheck.recheckedLive) {
      // Still detected but nothing to refresh (no structured params came
      // back from re-detection) — also not evidence either way. Leave it for
      // the next pass rather than spending a recovery cycle on a no-op.
      //
      // `recheckedLive` (set by recheckRecommendation's broken-link-fix
      // branch) is the exception: that type has no params to refresh even
      // on a genuine live re-check, so treating only `refreshed` as evidence
      // would mean a permanently-dead external citation (DNS failure,
      // expired cert) never accumulates a recovery cycle and never reaches
      // blockRecommendation — it would loop here forever instead of ever
      // escalating to a human.
      continue;
    }

    // The recommendation now reflects a genuine live re-check (fresh params,
    // when there were any to refresh). Abandon any draft still sitting
    // against this finding so the next generation attempt is guaranteed to
    // build from current evidence, not a draft built from the old attempt.
    const findingId = findingIds[0];
    const liveDraft = findingId ? await getDraftByFindingId(siteId, findingId) : null;
    if (liveDraft) {
      await markDraftAbandoned(siteId, liveDraft.id, 'Superseded by an autonomous re-analysis: the page was re-checked and this recommendation now targets freshly re-detected content.', null);
    }

    await recordAttempt(siteId, {
      recommendationId: rec.id,
      findingId,
      draftId: liveDraft?.id ?? null,
      outcome: 'recovered',
      // Explicit RETRY, not left to recordAttempt's own auto-classification:
      // free-text-classifying THIS reason would default it to ITEM_DEFECT
      // (attempt-classification.js's fallback for unrecognized text), which
      // would count a recovery event itself as another item-defect failure
      // in attemptSummaryByFinding's displayed count — wrong, since a
      // recovery is the opposite claim: the prior failures don't count
      // against the fresh evidence this attempt now has.
      retryPolicy: RETRY_POLICY.RETRY,
      reason: recheck.refreshed
        ? `Re-analyzed against live content after ${attempts} failed attempt(s) on stale evidence; recommendation params refreshed for a fresh attempt.`
        : `Re-checked live after ${attempts} failed attempt(s) — still confirmed the same issue against current content; no params to refresh, but this counts as a fresh recovery cycle.`,
    });
    result.recovered += 1;
    log?.(`[reconciler] site ${siteId}: rec ${rec.id} recovered — re-detected live${recheck.refreshed ? ', params refreshed' : ' (no params to refresh)'} (recovery cycle ${cycles + 1}/${MAX_RECOVERY_CYCLES})`);
  }
  return result;
}

// The refusal-cap counterpart to driveAutonomousRecovery above — same
// "spend a recovery cycle on fresh evidence, or hand it to a human once
// exhausted" shape, applied to ship-pacing.js's applyRefusalCap
// (MAX_REFUSALS) instead of applyConvergenceCap. Built from a real,
// verified case on site 1 (2026-09-17): 20 broken-link-fix recommendations
// held after 5 refusals each, most of which were actually caused by GitHub
// rate limiting during the exact runs that produced them — re-checking one
// by hand once the rate limit cleared found it genuinely fixable, but
// nothing autonomous would ever have re-tried it; applyRefusalCap filters a
// held item out of every future candidate list before the generate/push
// loop can see it again, so a refusal caused by a since-resolved transient
// condition sat re-classified as a permanent defect forever, identically to
// a genuinely unfixable one.
//
// Deliberately does NOT ship anything itself — same discipline
// learned-repair.js was fixed to follow (see its own comment: shipping
// directly from a second autonomous entry point bypasses the daily ceiling
// and the "one shared batch PR" rule every other producer respects). This
// only re-verifies, READ-ONLY, and records a recovery cycle (raising the
// effective cap) or closes the recommendation outright when the
// implementer's own check proves the finding is stale — the next
// scheduled auto-remediation.js run is what actually attempts the ship,
// through the normal shared pipeline, with the daily ceiling and pacing it
// already respects.
//
// Applies to every generator that exposes a `verifyCurrentState` (see
// server/generators/lib/verification-layer.js) — currently broken-link-fix
// and redirect-fix, the two generators whose implementer computation
// (backend.js) exposes a real, read-only "would this succeed right now"
// check with no side effects. A generator with no verifier is left exactly
// as before it existed (still permanently held once its refusal cap is
// reached) — a real, honest scope limit, not a silent gap: extending this
// to another generator means giving IT an equivalent read-only
// re-verification first (its own `verifyCurrentState`), not looping it in
// here blind.
async function driveAutonomousRefusalRecovery(siteId, { apply, log }) {
  const counts = await countRefusalsByRecommendation(siteId);
  const result = { recovered: 0, resolved: 0, blocked: 0, recommendations: [] };
  if (counts.size === 0) return result;

  const recoveries = await countRefusalRecoveryCyclesByRecommendation(siteId);
  const openRecs = await listOpenRecommendations(siteId);
  // Same real scope limit as before, just generalized: a recommendation only
  // enters this pass at all if ITS OWN generator has a verifier — a held
  // type with none is left exactly as if this pass didn't exist for it, not
  // merely skipped-and-counted.
  const candidates = [];
  for (const rec of openRecs) {
    if (rec.blocked_reason) continue;
    const generator = await getGenerator(rec.recommendation_type);
    if (typeof generator?.verifyCurrentState === 'function') candidates.push(rec);
  }
  if (!candidates.length) return result;

  let site = null;
  for (const rec of candidates) {
    const refusals = counts.get(rec.id) || 0;
    const cycles = recoveries.get(rec.id) || 0;
    if (refusals < effectiveRefusalCap(cycles)) continue;

    result.recommendations.push({ id: rec.id, refusals, cycles });
    if (!apply) continue;

    if (cycles >= MAX_REFUSAL_RECOVERY_CYCLES) {
      await blockRecommendation(
        rec.id,
        `This has been refused ${refusals} times across ${cycles} autonomous re-checks, each against freshly re-fetched live/repo content. It needs a human to look at it directly.`,
      );
      result.blocked += 1;
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} blocked — ${cycles} refusal-recovery cycles exhausted, ${refusals} total refusals`);
      continue;
    }

    site = site ?? await getSiteById(siteId);
    if (!site) continue; // no evidence to re-check against — leave for next pass

    const verification = await verifyRecommendation(rec, { site });
    if (verification.reason === 'verification-error') {
      // A transient error re-checking (rate limit, network) is not evidence
      // about the finding — must not consume a recovery cycle, same
      // reasoning driveAutonomousRecovery's own re-detection-failure catch
      // uses above. verifyRecommendation itself never throws (it catches
      // internally and reports this reason instead), so this checks the
      // reported reason rather than a try/catch.
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} refusal-recovery re-check failed (${verification.evidence?.error}) — will retry next run`);
      continue;
    }

    if (verification.decision === VERIFICATION_DECISION.ALREADY_RESOLVED) {
      // The generator's own live/repo re-check confirms this recommendation's
      // premise is genuinely gone now — nothing left to fix, same as
      // driveAutonomousRecovery's "resolved on re-check" case.
      await closeRecommendation(rec.id);
      result.resolved += 1;
      log?.(`[reconciler] site ${siteId}: rec ${rec.id} resolved on refusal-recovery re-check — confirmed gone (${verification.reason}), closed`);
      continue;
    }

    // Whether the fix is now genuinely fixable (the next scheduled ship run
    // will pick it up and actually apply it, through the normal shared
    // pipeline) or still blocked for a real, current reason, fresh evidence
    // was gathered either way. Recording the cycle now is what raises the
    // effective cap so applyRefusalCap stops filtering this candidate out of
    // tomorrow's queue.
    const nowFixable = verification.reason === 'fixable-now';
    await recordAttempt(siteId, {
      recommendationId: rec.id, findingId: null, draftId: null,
      outcome: 'recovered', retryPolicy: RETRY_POLICY.RETRY,
      reason: nowFixable
        ? `Re-checked live after ${refusals} refusal(s) — no longer blocked by what was blocking it before; this counts as a fresh refusal-recovery cycle and will be re-attempted on the next scheduled run.`
        : `Re-checked live after ${refusals} refusal(s) — still confirmed the same issue against current live/repo content (${verification.reason}); this counts as a fresh refusal-recovery cycle.`,
    });
    result.recovered += 1;
    log?.(`[reconciler] site ${siteId}: rec ${rec.id} refusal-recovery cycle spent — ${nowFixable ? 'now fixable, queued for next ship run' : 'still refuses'} (cycle ${cycles + 1}/${MAX_REFUSAL_RECOVERY_CYCLES})`);
  }
  return result;
}

// Reconciles one site. `apply: false` makes it a pure dry run — it reports
// exactly what it would do and writes nothing, which is how this gets
// verified against production data before being trusted to run unattended.
export async function reconcileSite(siteId, { idleHours = IDLE_RECLAIM_HOURS, apply = true, log = console.log } = {}) {
  // Pass 0 — finish work that is ALREADY on GitHub before any later pass is
  // allowed to throw it away. Ordering is the whole point: pass 2 below
  // reclaims a 'branch_pushed' draft purely on lack of progress, and a batch
  // whose commits landed but whose PR call failed looks identical to one that
  // never pushed at all. Running the reclaim first meant every such batch was
  // abandoned and regenerated from scratch the next day, forever — the commits
  // discarded, the model spend repeated, and the recommendation's card
  // reporting "tried 7 times". lib/batch-pr-recovery.js settles which of the
  // two it is against GitHub and opens the one missing PR, so pass 2 only
  // ever sees genuinely dead work.
  //
  // openDraftPr is injected rather than imported: it lives in the Express
  // route module, which imports far more of the app than a janitor should
  // pull in, and a static import here would make routes/action-center.js and
  // this file a cycle.
  const prRecovery = await recoverUnopenedBatchPrs(siteId, {
    apply,
    log,
    openPr: async (id, draftId) => (await import('../routes/action-center.js')).openDraftPr(id, draftId),
  });
  const itemDefects = await reconcileStuckApprovedDrafts(siteId, { apply, log });
  const stalled = await reclaimStalledDrafts(siteId, { idleHours, apply, log });
  const failures = await classifyUnrecordedFailures(siteId, { apply, log });
  const recovery = await driveAutonomousRecovery(siteId, { apply, log });
  const refusalRecovery = await driveAutonomousRefusalRecovery(siteId, { apply, log });
  return { siteId, prRecovery, stalled, failures, itemDefects, recovery, refusalRecovery };
}

// Every site, one at a time. Sequential on purpose: this shares a connection
// pool with the request path and with the agent battery, and a fan-out over
// every site buys nothing here — the work is small per site and never
// latency-critical.
export async function reconcileAllSites({ idleHours = IDLE_RECLAIM_HOURS, apply = true, log = console.log } = {}) {
  const { rows: sites } = await query('SELECT id, client_number FROM sites ORDER BY id');
  const results = [];
  for (const site of sites) {
    const clientLabel = site.client_number ? `client #${site.client_number}` : `site ${site.id}`;
    try {
      results.push(await reconcileSite(site.id, { idleHours, apply, log }));
    } catch (err) {
      // One site's failure must not stop the sweep for every other site —
      // this is a multi-tenant janitor, and a single tenant's bad row
      // silently costing every other tenant their reconciliation is exactly
      // the shape of outage this file exists to prevent.
      //
      // The exception itself goes to the internal log, where full detail is
      // allowed; `log` receives only a correlation id. It defaults to
      // console.log but is caller-supplied and can route anywhere — this
      // module's CLI prints it to stdout, and a future caller could store it
      // on an execution_job — so it must never carry raw exception text.
      const id = logInternal(`action-center-reconciler site ${site.id}`, err);
      log?.(`[reconciler] ${clientLabel} failed (ref: ${id})`);
    }
  }
  const totals = results.reduce((acc, r) => ({
    reclaimed: acc.reclaimed + r.stalled.reclaimed,
    reopened: acc.reopened + r.stalled.reopened,
    classified: acc.classified + r.failures.classified,
    blocked: acc.blocked + r.failures.blocked + r.recovery.blocked + r.refusalRecovery.blocked,
    resolved: acc.resolved + r.failures.resolved + r.recovery.resolved + r.refusalRecovery.resolved,
    abandonedForRetry: acc.abandonedForRetry + r.itemDefects.abandoned,
    recovered: acc.recovered + r.recovery.recovered + r.refusalRecovery.recovered,
  }), { reclaimed: 0, reopened: 0, classified: 0, blocked: 0, resolved: 0, abandonedForRetry: 0, recovered: 0 });
  return { results, totals };
}
