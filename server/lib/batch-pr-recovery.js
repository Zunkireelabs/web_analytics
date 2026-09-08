// Pass 0 of the reconciler — finishes a batch whose commits reached GitHub
// but whose PR never opened.
//
// THE BUG THIS EXISTS FOR. finalizeBatchPr (routes/action-center.js) does two
// separate things: endBatchPush moves the branch ref once for the whole run,
// then openDraftPr opens ONE PR for it. When the first succeeds and the
// second fails — the ordinary shape of a GitHub secondary rate limit, since
// PR creation is the last content-creating call of a long batch — every draft
// in the batch is left at 'branch_pushed' with the PR-stage error recorded by
// recordMergeFailure. From there:
//
//   - lib/draft-ship-state.js reads ANY apply_error on 'branch_pushed' as
//     proof the commit was never pushed (true for a push-stage failure) and
//     returns STRANDED;
//   - the reconciler's stall reclaim (pass 2) then abandons the draft after
//     IDLE_RECLAIM_HOURS and reopens the recommendation as a plain RETRY;
//   - the next run regenerates the whole draft with a fresh model call and
//     pushes a NEW date-keyed branch, which hits the same wall.
//
// Nothing in that loop ever retries the one cheap call that would finish the
// work, and RETRY never counts toward the convergence cap, so it repeats
// indefinitely. Measured on site 1 on 2026-09-08: 21 drafts at
// 'branch_pushed' with no PR across two date-keyed branches, both of which
// existed on GitHub with real commits ahead of `main`, while the Action
// Center showed their recommendations as "tried 7 times".
//
// WHY IT VERIFIES INSTEAD OF TRUSTING THE ERROR TEXT. The difference between
// "the push failed" and "the push landed, the PR failed" decides between
// regenerating every draft and opening one PR — far too consequential to
// settle by pattern-matching prose (this codebase's standing warning:
// "matching prose is how a classifier quietly stops recognising the thing it
// was written for"). So this asks GitHub what is actually on the branch
// (listCommitSubjectsAheadOfBase) and matches each draft against its own
// commit subject. A draft whose commit is genuinely absent is abandoned for
// clean regeneration — the repo's own recorded lesson, never leave a
// partially-failed draft in a non-terminal status — rather than being
// reported as shipped against a PR that does not contain its change.
//
// It deliberately does NOT create branches, write files, or regenerate
// content. The only mutation it can cause on GitHub is opening a pull request
// for commits that are already pushed.
import { query } from '../db.js';
import { getSiteById } from '../store/read.js';
import { markDraftAbandoned, markDraftPrOpened, clearApplyErrorForPushedDraft } from '../store/drafts.js';
import { recordAttempt } from '../store/recommendation-attempts.js';
import { RETRY_POLICY } from './attempt-classification.js';
import { listCommitSubjectsAheadOfBase, listOpenPullRequestsForBranch, getLastKnownRateLimit } from '../github/client.js';
import { logInternal } from './errors.js';

// pushDraftBranch's commit subject is
// `Action Center: apply <action_type> draft #<id>` (plus an optional
// family-write marker). The id is the only part needed to attribute a commit,
// and matching on it alone keeps this working if the rest of the subject is
// ever reworded.
function commitSubjectMatchesDraft(subject, draftId) {
  return new RegExp(`draft #${draftId}(?!\\d)`).test(subject);
}

// One branch's worth of drafts. Returns a per-branch summary; never throws
// for an ordinary GitHub failure, so one bad branch cannot stop the sweep.
async function recoverBranch(site, branchName, drafts, { apply, log, openPr }) {
  const siteId = site.id;
  const summary = { branch: branchName, drafts: drafts.length, opened: 0, adopted: 0, abandoned: 0, skipped: 0 };

  let subjects;
  try {
    subjects = await listCommitSubjectsAheadOfBase(site, branchName);
  } catch (err) {
    // Transient GitHub failure. Leave everything exactly as it is — pass 2's
    // idle window is long enough that the next hourly run gets another go
    // before anything is reclaimed.
    const ref = logInternal(`batch-pr-recovery.compare ${branchName}`, err);
    log?.(`[pr-recovery] site ${siteId}: could not read branch ${branchName} (ref: ${ref}) — leaving it for the next run`);
    summary.skipped = drafts.length;
    return summary;
  }

  // null = the branch is gone (deleted, or never created because the push
  // stage is what failed). Nothing to recover; pass 2 reclaims these on its
  // own schedule, and abandoning them here would duplicate that decision in
  // a second place.
  if (subjects === null) {
    log?.(`[pr-recovery] site ${siteId}: branch ${branchName} no longer exists — leaving ${drafts.length} draft(s) to the stall reclaim`);
    summary.skipped = drafts.length;
    return summary;
  }

  const landed = [];
  const missing = [];
  for (const draft of drafts) {
    (subjects.some((s) => commitSubjectMatchesDraft(s, draft.id)) ? landed : missing).push(draft);
  }

  // A draft whose commit is NOT on the branch was stranded by a failed push,
  // not a failed PR. Abandon it so the next pass regenerates it cleanly —
  // and, critically, so it is never swept into a PR that does not contain
  // its change. This is the honest half of the fix; without it, "open the PR
  // anyway" would report work as shipped that does not exist.
  for (const draft of missing) {
    summary.abandoned += 1;
    if (!apply) continue;
    await markDraftAbandoned(
      siteId, draft.id,
      'Recovered: the batch push never landed this change on GitHub, so it was returned for a clean retry.',
    ).catch((err) => {
      logInternal(`batch-pr-recovery.abandon draft ${draft.id}`, err);
    });
  }

  if (landed.length === 0) return summary;

  // Correct the record BEFORE attempting the PR. These commits are confirmed
  // on the branch, so a lingering PR-stage apply_error is now a false
  // statement about them — and it is the statement draftShipState reads as
  // "this commit was never pushed", which is what sends a fully-pushed draft
  // back for regeneration. Doing it here rather than after the PR call means
  // a still-rate-limited run leaves the drafts ACCURATE and recoverable
  // instead of leaving the same wrong flag set for another day.
  if (apply) {
    for (const draft of landed) {
      await clearApplyErrorForPushedDraft(siteId, draft.id)
        .catch((err) => logInternal(`batch-pr-recovery.clearApplyError draft ${draft.id}`, err));
    }
  }

  // Already-open PR for this head: adopt it rather than trying to open a
  // second one (GitHub 422s on a duplicate head->base pair). This also
  // self-heals plain bookkeeping drift — a PR that opened while the response
  // was lost leaves exactly this state.
  let existing = [];
  try {
    existing = await listOpenPullRequestsForBranch(site, branchName);
  } catch (err) {
    const ref = logInternal(`batch-pr-recovery.listPrs ${branchName}`, err);
    log?.(`[pr-recovery] site ${siteId}: could not list PRs for ${branchName} (ref: ${ref}) — leaving it for the next run`);
    summary.skipped += landed.length;
    return summary;
  }

  if (existing.length > 0) {
    const pr = existing[0];
    log?.(`[pr-recovery] site ${siteId}: branch ${branchName} already has PR #${pr.number} — attaching ${landed.length} draft(s) to it`);
    for (const draft of landed) {
      summary.adopted += 1;
      if (!apply) continue;
      await markDraftPrOpened(siteId, draft.id, { prNumber: pr.number, prUrl: pr.html_url, rollbackSnapshot: null })
        .catch((err) => logInternal(`batch-pr-recovery.adopt draft ${draft.id}`, err));
    }
    return summary;
  }

  if (!apply) {
    summary.opened = landed.length;
    return summary;
  }

  // Open exactly ONE PR, through the same openDraftPr the manual retry
  // button and finalizeBatchPr both use, then attach every other landed
  // draft to it. Injected rather than imported so this module doesn't pull
  // in the whole Express route file (and so the test can drive it).
  let opened;
  try {
    opened = await openPr(siteId, landed[0].id);
  } catch (err) {
    const ref = err.rateLimited ? 'rate limit' : logInternal(`batch-pr-recovery.openPr draft ${landed[0].id}`, err);
    log?.(`[pr-recovery] site ${siteId}: PR for ${branchName} still could not be opened (${ref}) — ${landed.length} draft(s) stay recoverable`);
    summary.skipped += landed.length;
    return summary;
  }

  summary.opened += 1;
  for (const draft of landed.slice(1)) {
    await markDraftPrOpened(siteId, draft.id, { prNumber: opened.pr_number, prUrl: opened.pr_url, rollbackSnapshot: null })
      .then(() => { summary.opened += 1; })
      .catch((err) => logInternal(`batch-pr-recovery.attach draft ${draft.id}`, err));
  }
  log?.(`[pr-recovery] site ${siteId}: opened PR ${opened.pr_url} for ${branchName}, finishing ${summary.opened} draft(s)`);

  // Every recovered draft's recommendation gets an attempt row saying the
  // work landed after all, so the Action Center card stops showing a failure
  // that has been resolved.
  for (const draft of landed) {
    if (!draft.finding_id) continue;
    await recordAttempt(siteId, {
      recommendationId: null,
      findingId: draft.finding_id,
      draftId: draft.id,
      outcome: 'recovered',
      retryPolicy: RETRY_POLICY.RETRY,
      reason: `The change was already pushed; its pull request was opened on a later pass (${opened.pr_url}).`,
    }).catch((err) => logInternal(`batch-pr-recovery.recordAttempt draft ${draft.id}`, err));
  }
  return summary;
}

/**
 * Finishes every branch of one site that holds pushed-but-unopened work.
 *
 * @param {number} siteId
 * @param {object} opts
 * @param {boolean} [opts.apply] false = dry run, writes nothing anywhere.
 * @param {Function} [opts.openPr] injected openDraftPr(siteId, draftId).
 */
export async function recoverUnopenedBatchPrs(siteId, { apply = true, log = console.log, openPr } = {}) {
  const result = { branches: 0, opened: 0, adopted: 0, abandoned: 0, skipped: 0, details: [] };
  if (typeof openPr !== 'function') throw new Error('recoverUnopenedBatchPrs requires an openPr implementation');

  const { rows: drafts } = await query(
    `SELECT id, finding_id, branch_name, action_type
       FROM drafts
      WHERE site_id = $1
        AND status = 'branch_pushed'
        AND pr_number IS NULL
        AND branch_name IS NOT NULL
        AND branch_name <> ''
      ORDER BY updated_at ASC`,
    [siteId],
  );
  if (drafts.length === 0) return result;

  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) return result;

  // The budget check that matters: this pass exists BECAUSE a rate limit
  // broke the batch, so running it while the same limit is still in force
  // just re-fails every branch and spends what little is left. Unknown reads
  // as not-low (see getLastKnownRateLimit), so a fresh process still tries.
  if (getLastKnownRateLimit(site).low) {
    log?.(`[pr-recovery] site ${siteId}: GitHub budget still low — deferring ${drafts.length} draft(s) to the next run`);
    result.skipped = drafts.length;
    return result;
  }

  const byBranch = new Map();
  for (const d of drafts) {
    if (!byBranch.has(d.branch_name)) byBranch.set(d.branch_name, []);
    byBranch.get(d.branch_name).push(d);
  }

  for (const [branchName, branchDrafts] of byBranch) {
    const summary = await recoverBranch(site, branchName, branchDrafts, { apply, log, openPr });
    result.branches += 1;
    result.opened += summary.opened;
    result.adopted += summary.adopted;
    result.abandoned += summary.abandoned;
    result.skipped += summary.skipped;
    result.details.push(summary);
  }
  return result;
}
