import { query } from '../db.js';
import { isVerifiableDraft, createPendingVerification, getWatchlistItemByFindingId } from './fix-verifications.js';

// CRUD for the drafts table, plus its approval lifecycle:
// draft/edited -> submitted_for_approval -> approved -> implemented. There's
// still no CMS integration to push content to — "implemented" means a
// person put the approved content live on the real site and told the
// dashboard so, the same real-evidence pattern hasDraftSince() already
// leans on for the Watchlist, one step further along.

export async function createDraft(siteId, { actionType, source, input, content, findingId }) {
  const { rows } = await query(
    `INSERT INTO drafts (site_id, action_type, source, input, content, finding_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [siteId, actionType, source ?? null, JSON.stringify(input ?? {}), JSON.stringify(content), findingId || null]
  );
  return rows[0];
}

export async function listDrafts(siteId, { actionType, status } = {}) {
  const conditions = ['site_id = $1'];
  const values = [siteId];
  if (actionType) { values.push(actionType); conditions.push(`action_type = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  const { rows } = await query(
    `SELECT * FROM drafts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function getDraft(siteId, id) {
  const { rows } = await query('SELECT * FROM drafts WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rows[0] || null;
}

// Content-only edit — only valid pre-approval. Without the status guard, this
// would silently force ANY draft (including an already-approved or already-
// implemented one) back to 'edited', stranding stale approved_at/approved_by/
// implemented_at values on a row that now claims to be back at square one.
export async function updateDraft(siteId, id, { content }) {
  const { rows } = await query(
    `UPDATE drafts SET content = $1, status = 'edited', updated_at = now()
     WHERE site_id = $2 AND id = $3 AND status IN ('draft', 'edited')
     RETURNING *`,
    [JSON.stringify(content), siteId, id]
  );
  return rows[0] || null;
}

export async function deleteDraft(siteId, id) {
  const { rowCount } = await query('DELETE FROM drafts WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rowCount > 0;
}

// draft/edited -> submitted_for_approval. Only valid from an unsubmitted state.
export async function submitDraftForApproval(siteId, id) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'submitted_for_approval', updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status IN ('draft', 'edited')
     RETURNING *`,
    [siteId, id]
  );
  return rows[0] || null;
}

// submitted_for_approval -> approved. `approvedBy` is the approving user's
// id (req.userId) — who signed off, for the same reason git blame matters.
export async function approveDraft(siteId, id, approvedBy) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'approved', approved_at = now(), approved_by = $3, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'submitted_for_approval'
     RETURNING *`,
    [siteId, id, approvedBy]
  );
  return rows[0] || null;
}

// approved -> branch_pushed. Only ever called after an implementer's
// apply() has already succeeded against the real GitHub repo (a real
// branch, forked from stage, with the real change now exists — not merged
// yet) — this persists real evidence, it doesn't create it. Staff reviews
// the real diff (Draft Preview panel — same computation, now confirmed
// pushed) before the separate mergeToStage step below.
export async function markDraftBranchPushed(siteId, id, { branchName, implementerId }) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'branch_pushed', branch_name = $3, implementer_id = $4, apply_error = NULL, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, branchName, implementerId]
  );
  return rows[0] || null;
}

// branch_pushed -> merged_to_stage. Only ever called after an implementer's
// mergeToStage() has already succeeded against the real GitHub repo (a real
// merge commit on `stage`, which auto-deploys per the company's real CI/CD
// convention — no PR involved) — this persists real evidence, it doesn't
// create it.
// `rollbackSnapshot` ({filePath, content}) is optional — only writers that
// implement rollback() (see server/implementers/adapters/) supply one, by
// fetching the file's content BEFORE their mergeToStage() actually merges.
// null for every other draft type, same as before this column existed.
export async function markDraftMergedToStage(siteId, id, { mergeSha, mergeUrl, rollbackSnapshot = null }) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'merged_to_stage', stage_merge_sha = $3, stage_merge_url = $4,
       stage_merged_at = now(), apply_error = NULL, updated_at = now(),
       rollback_snapshot = COALESCE($5, rollback_snapshot)
     WHERE site_id = $1 AND id = $2 AND status = 'branch_pushed'
     RETURNING *`,
    [siteId, id, mergeSha, mergeUrl, rollbackSnapshot ? JSON.stringify(rollbackSnapshot) : null]
  );
  return rows[0] || null;
}

// branch_pushed -> pr_opened. Only ever called after an implementer's
// mergeToStage() has already succeeded in opening a real PR against the
// real GitHub repo (branch_name unchanged, now paired with a real PR number/
// URL) — this persists real evidence, it doesn't create it. `pr_number`/
// `pr_url`/`pr_state` are pre-existing columns from migration 029 (an
// earlier, abandoned PR-based design) reused here rather than adding new
// ones. `rollbackSnapshot` follows the same optional, writer-supplied
// pattern as markDraftMergedToStage below.
export async function markDraftPrOpened(siteId, id, { prNumber, prUrl, rollbackSnapshot = null }) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'pr_opened', pr_number = $3, pr_url = $4, pr_state = 'open',
       apply_error = NULL, updated_at = now(),
       rollback_snapshot = COALESCE($5, rollback_snapshot)
     WHERE site_id = $1 AND id = $2 AND status = 'branch_pushed'
     RETURNING *`,
    [siteId, id, prNumber, prUrl, rollbackSnapshot ? JSON.stringify(rollbackSnapshot) : null]
  );
  return rows[0] || null;
}

// Pure annotation write, no status guard — same pattern as
// recordGscNotification below. Used by the Check PR Status action to record
// GitHub's real current PR state ('open'/'closed') when it hasn't merged
// yet; the 'merged' case instead goes through markDraftImplemented (below),
// since that's a real lifecycle transition, not just an annotation.
export async function recordPrState(siteId, id, prState) {
  const { rows } = await query(
    'UPDATE drafts SET pr_state = $3, updated_at = now() WHERE site_id = $1 AND id = $2 RETURNING *',
    [siteId, id, prState]
  );
  return rows[0] || null;
}

// Best-effort record of the post-merge Search Console notification result
// (multi-tenant refactor Part 3) — does not gate or change draft status;
// this is pure audit visibility for Action Center, called after
// markDraftMergedToStage has already succeeded. No WHERE-status guard like
// the other transition functions since this never represents a lifecycle
// transition, just an annotation on whichever row already exists.
export async function recordGscNotification(siteId, id, result) {
  await query(
    'UPDATE drafts SET gsc_notification = $3 WHERE site_id = $1 AND id = $2',
    [siteId, id, JSON.stringify({ ...result, attemptedAt: new Date().toISOString() })]
  );
}

// Records a push-branch (apply()) failure without changing status, so
// "Push Branch" is simply retryable once the underlying issue (missing
// mapping, GitHub error) is fixed — never leaves a draft stuck in a broken
// state.
export async function recordApplyFailure(siteId, id, errorMessage) {
  const { rows } = await query(
    `UPDATE drafts SET apply_error = $3, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, errorMessage]
  );
  return rows[0] || null;
}

// Same retryable-in-place pattern as recordApplyFailure, for a
// mergeToStage() failure (e.g. a real merge conflict) — the branch itself
// is already real/pushed at this point, only the merge call failed, so this
// stays at branch_pushed rather than reverting anything.
export async function recordMergeFailure(siteId, id, errorMessage) {
  const { rows } = await query(
    `UPDATE drafts SET apply_error = $3, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'branch_pushed'
     RETURNING *`,
    [siteId, id, errorMessage]
  );
  return rows[0] || null;
}

// Every generator type now has a real, working merge-to-stage strategy (see
// server/implementers/backend.js's MARKER_MERGE_TYPES + llms-txt, and
// server/implementers/frontend.js for landing-page/blog-outline/translation)
// — a real merge into stage is the ONLY path to 'implemented' for all 8.
// The legacy manual bypass below is kept only as an escape hatch for a
// draft whose type somehow isn't in this list (defensive, not expected to
// ever apply today).
export const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation'];

// approved -> implemented. Three distinct evidence paths, all real:
//   - legacy manual path: ONLY for a draft whose generator type has no real
//     merge strategy at all (see MERGE_MANDATORY_TYPES above) —
//     "implemented" still means a person put the content live and said so.
//   - merge-to-stage path: status='merged_to_stage' — real, GitHub-confirmed
//     evidence a HISTORICAL draft (from before the PR-based flow below
//     replaced this) is live on staging. No new draft reaches this status
//     going forward; kept only so old rows still finalize correctly.
//   - PR-merged path (current, mandatory for MERGE_MANDATORY_TYPES):
//     status='pr_opened' AND pr_state='merged' — real, GitHub-confirmed
//     evidence a human reviewed and merged the draft's PR into `main`.
//     Called by the Check PR Status action (server/routes/action-center.js's
//     /check-pr-status) once getPullRequest() reports merged:true — there's
//     no way to know earlier, since merging is now a manual human action on
//     GitHub, not something this app triggers.
// This is the real evidence hasDraftSince() below (and the Watchlist's
// completion check) requires — a draft merely existing, or even being
// approved, isn't the same as the change actually being live on the site.
//
// For drafts with a real finding_id + page + a re-checkable generator (see
// isVerifiableDraft), this also schedules a real Verify stage re-check
// (server/agents/lib/fix-verification.js) — re-fetching the exact flagged
// page in ~48h and re-running the exact check that flagged it, instead of
// trusting that "implemented" alone means the issue is actually gone.
export async function markDraftImplemented(siteId, id) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'implemented', implemented_at = now(), updated_at = now()
     WHERE site_id = $1 AND id = $2 AND (
       (status = 'approved' AND branch_name IS NULL AND NOT (action_type = ANY($3)))
       OR status = 'merged_to_stage'
       OR (status = 'pr_opened' AND pr_state = 'merged')
     )
     RETURNING *`,
    [siteId, id, MERGE_MANDATORY_TYPES]
  );
  const draft = rows[0] || null;
  if (draft && isVerifiableDraft(draft)) {
    const watchlistItem = await getWatchlistItemByFindingId(siteId, draft.finding_id);
    await createPendingVerification(siteId, {
      watchlistItemId: watchlistItem?.id ?? null,
      findingId: draft.finding_id,
      draftId: draft.id,
      pageUrl: draft.input.page,
      generatorId: draft.action_type,
      queryText: draft.input.query ?? null,
      source: draft.source,
    });
  }
  return draft;
}

// Real evidence a recommendation was actually acted on, not just that it
// disappeared — used by the Opportunity Watchlist (agents/lib/watchlist.js)
// to distinguish "completed" (the recommendation was actually implemented)
// from "no longer applicable" (it just stopped being relevant). Requires
// `implemented` specifically — a draft merely existing (or even approved
// but not yet live) isn't real evidence the action was taken.
export async function hasDraftSince(siteId, source, actionType, since) {
  const { rows } = await query(
    "SELECT 1 FROM drafts WHERE site_id = $1 AND source = $2 AND action_type = $3 AND created_at >= $4 AND status = 'implemented' LIMIT 1",
    [siteId, source, actionType, since]
  );
  return rows.length > 0;
}

// Every finding_id with at least one implemented draft — finding ids are
// stable slugs (e.g. `content-gap:<page>:Missing FAQ`, see agents/types.js),
// so this reliably answers "already shipped" even though the underlying
// agent re-derives the same finding fresh on its next scheduled run.
// Used by buildRecommendations (agents/lib/recommendations.js) to stop
// resurfacing a finding in the Findings List once its fix is actually live,
// instead of waiting on the next agent run to naturally stop re-detecting it.
export async function getImplementedFindingIds(siteId) {
  const { rows } = await query(
    "SELECT DISTINCT finding_id FROM drafts WHERE site_id = $1 AND status = 'implemented' AND finding_id IS NOT NULL",
    [siteId]
  );
  return new Set(rows.map((r) => r.finding_id));
}
