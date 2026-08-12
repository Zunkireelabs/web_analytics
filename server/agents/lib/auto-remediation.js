import { listOpenRecommendations } from '../../store/recommendations.js';
import { getDraftedFindingIds, submitDraftForApproval, updateDraft, countDraftsBySourceToday } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { generateDraft, approveAndPublishDraft, autoSelectMetaTitle, openDraftPr } from '../../routes/action-center.js';

const SOURCE = 'auto-remediation';

// How many consecutive failures trip the breaker for the rest of this site's
// run. Consecutive rather than cumulative on purpose: an occasional failure
// mixed in with successes is normal (one bad page among many), whereas three
// in a row is the signature of something systemic — a revoked GitHub token, a
// url_file_map that stopped resolving, a repo whose default branch moved.
// Without this, one such fault burns the entire daily budget on 30 identical
// failures and buries the real cause in noise.
const CONSECUTIVE_FAILURE_LIMIT = 3;

// Stage 3-4 of Generate -> Validate -> Auto-fix -> Validate again -> Action
// Center: closes the loop risk-tiers.js opened. A 'safe'-tier recommendation
// doesn't need a human to click anything — generateDraft() already runs the
// Quality Gate (generators/lib/quality-gate.js) with a bounded regeneration
// attempt, and approveAndPublishDraft() re-validates before the PR opens, so
// this function is deliberately thin: draft it, submit it, publish it, and
// let those two gates be the only thing standing between a detected issue
// and a real PR. On a Quality Gate rejection (or any other failure) the
// recommendation is simply left open — getRecommendations() only hides a
// recommendation once a draft actually exists for it, so an issue this
// couldn't safely auto-fix surfaces in the Action Center exactly like any
// other issue that "genuinely requires human judgment."
//
// Called after syncFromGrounded() from both server/job.js's daily cron and
// routes/action-center.js's refreshRecommendations() — the same two places
// that already create/refresh recommendation rows — so every path that can
// detect a safe-tier issue also gets a chance to auto-remediate it, not just
// one of them.
//
// Opt-in per site (sites.auto_remediation_enabled, migration 089) — see that
// migration's comment for why this isn't on by default.
//
// Bounded on three axes, because "unattended" and "unbounded" are not the
// same thing and this loop runs against real customer repositories:
//   1. Daily budget — sites.auto_remediation_daily_limit (migration 101,
//      default 30), counted in the SITE'S timezone. Before this existed the
//      loop had no cap at all and would have fired every open safe-tier
//      recommendation in a single pass the first morning it was enabled.
//   2. Circuit breaker — CONSECUTIVE_FAILURE_LIMIT below.
//   3. Risk tier — only 'safe' generators, which now also excludes anything
//      the design-verification gate blocked (those are demoted to 'manual').
//
// It ends at an OPEN PULL REQUEST and never merges — see the openDraftPr call
// below for why that boundary is deliberate rather than incidental.
export async function autoRemediateSafeRecommendations(siteId) {
  const site = await getSiteById(siteId);
  if (!site?.auto_remediation_enabled) return { attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'disabled' };

  const [rows, draftedFindingIds, spentToday] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
    countDraftsBySourceToday(siteId, SOURCE, site.timezone || 'UTC'),
  ]);
  // A design-blocked recommendation is already forced to risk_tier 'manual'
  // by recommendation-coordinator.js, so this existing 'safe' filter also
  // excludes it — no separate design check is needed here, and no future
  // unattended caller can forget one.
  const candidates = rows.filter((r) => r.risk_tier === 'safe' && r.finding_ids.every((fid) => !draftedFindingIds.has(fid)));

  // Daily budget. `remaining` can go negative if the limit was lowered
  // mid-day after work was already done — Math.max keeps that a clean "no
  // budget left" rather than a negative slice that would silently take
  // everything.
  const dailyLimit = site.auto_remediation_daily_limit ?? 30;
  const remaining = Math.max(0, dailyLimit - spentToday);
  if (remaining === 0) {
    console.log(`[auto-remediation] site ${siteId} has already used its full daily budget (${spentToday}/${dailyLimit}) — nothing attempted this run.`);
    return { attempted: 0, shipped: 0, failed: 0, skipped: candidates.length, spentToday, dailyLimit, stoppedReason: 'budget-exhausted' };
  }

  const budgeted = candidates.slice(0, remaining);
  // Never silently truncate: a run that ships 30 of 41 open issues must say
  // so, or the Action Center looks like it simply found fewer problems.
  if (budgeted.length < candidates.length) {
    console.log(`[auto-remediation] site ${siteId}: ${candidates.length} eligible, taking ${budgeted.length} within today's budget (${spentToday}/${dailyLimit} already used); ${candidates.length - budgeted.length} deferred to tomorrow.`);
  }

  let shipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stoppedReason = null;
  let attempted = 0;

  for (const rec of budgeted) {
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      stoppedReason = 'circuit-breaker';
      console.error(`[auto-remediation] site ${siteId}: ${CONSECUTIVE_FAILURE_LIMIT} consecutive failures — stopping this site's run early to avoid burning the daily budget on a systemic fault. ${budgeted.length - attempted} candidate(s) left untouched and still open.`);
      break;
    }
    attempted++;
    try {
      const draft = await generateDraft(siteId, {
        generatorId: rec.recommendation_type, params: rec.params, source: SOURCE, findingId: rec.finding_ids[0],
      });

      const autoSelected = autoSelectMetaTitle(rec.recommendation_type, draft.content);
      if (autoSelected) {
        const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
        if (updated) draft.content = updated.content;
      }

      const submitted = await submitDraftForApproval(siteId, draft.id);
      if (!submitted) throw new Error('Draft was not in a submittable state');

      const approved = await approveAndPublishDraft(siteId, draft.id, { userId: null });
      if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');

      // Open the PR, and STOP. This loop deliberately never merges and never
      // calls markDraftImplemented: a human reviewing and merging on GitHub is
      // the intended final gate, and the existing PR-status poller
      // (cron.js's ':20 past the hour' runPrStatusPollForAllSites) is what
      // flips the draft to 'implemented' once that merge actually happens.
      // So the unattended chain ends at a reviewable PR, by design.
      //
      // A failure HERE is different in kind from a failure above: the branch
      // is already pushed and the work is real, it just isn't proposed yet.
      // Counting it as shipped would overstate what landed, so it counts as a
      // failure — but the draft is left at 'branch_pushed', where the manual
      // "Open PR" button in Action Center can still finish it without
      // regenerating anything.
      await openDraftPr(siteId, draft.id);

      shipped++;
      consecutiveFailures = 0;
    } catch (err) {
      failed++;
      consecutiveFailures++;
      console.warn(`[auto-remediation] site ${siteId} could not auto-fix recommendation ${rec.id} (${rec.recommendation_type}), leaving it open:`, err.message);
    }
  }
  return {
    attempted, shipped, failed,
    skipped: candidates.length - attempted,
    spentToday, dailyLimit, stoppedReason,
  };
}
