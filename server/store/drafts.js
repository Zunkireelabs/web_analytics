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

// Correlated subquery, not a separate lookup — avoids an N+1 query on the
// drafts list view. Naturally evaluates to 0 when branch_name IS NULL,
// since NULL = NULL is never true in SQL.
const SIBLING_COUNT_SELECT = `d.*, (
  SELECT COUNT(*)::int FROM drafts d2
  WHERE d2.site_id = d.site_id AND d2.branch_name = d.branch_name AND d2.id != d.id
) AS sibling_count`;

export async function listDrafts(siteId, { actionType, status } = {}) {
  const conditions = ['d.site_id = $1'];
  const values = [siteId];
  if (actionType) { values.push(actionType); conditions.push(`d.action_type = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`d.status = $${values.length}`); }
  const { rows } = await query(
    `SELECT ${SIBLING_COUNT_SELECT} FROM drafts d WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC`,
    values
  );
  return rows;
}

export async function getDraft(siteId, id) {
  const { rows } = await query(
    `SELECT ${SIBLING_COUNT_SELECT} FROM drafts d WHERE d.site_id = $1 AND d.id = $2`,
    [siteId, id]
  );
  return rows[0] || null;
}

// Counts other draft rows on this site sharing this exact branch_name —
// gates Rollback, since whole-file snapshot/restore is only safe when a
// draft is genuinely alone on its branch; a shared batch branch may hold
// sibling drafts' edits to the same or a different file that a whole-file
// restore would silently clobber. Returns 0 for a draft with no branch_name
// yet (nothing to share).
export async function countSiblingDraftsOnBranch(siteId, branchName, excludeId) {
  if (!branchName) return 0;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM drafts WHERE site_id = $1 AND branch_name = $2 AND id != $3`,
    [siteId, branchName, excludeId]
  );
  return rows[0].n;
}

// Content-only edit — only valid pre-approval, OR while a reviewer has sent
// it back for changes ('revision_requested' — Phase 3 approval workflow,
// see requestDraftRevision below). Without the status guard, this would
// silently force ANY draft (including an already-approved or already-
// implemented one) back to 'edited', stranding stale approved_at/approved_by/
// implemented_at values on a row that now claims to be back at square one.
export async function updateDraft(siteId, id, { content }) {
  const { rows } = await query(
    `UPDATE drafts SET content = $1, status = 'edited', updated_at = now()
     WHERE site_id = $2 AND id = $3 AND status IN ('draft', 'edited', 'revision_requested')
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
// `appliedFiles` ([{filePath, matchedVia, matchedFrom}]) is optional — only
// broken-link-fix's pushBrokenLinkFixBranch (server/implementers/backend.js)
// supplies it today, so previewLiveBrokenLinkFix can re-check exactly the
// files that were actually touched (including a code-search match that
// isn't re-derivable from url_file_map alone) rather than re-resolving live
// on every preview click. null/undefined for every other action type, same
// as before this param existed.
export async function markDraftBranchPushed(siteId, id, { branchName, implementerId, renderMode = null, appliedFiles = null }) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'branch_pushed', branch_name = $3, implementer_id = $4, render_mode = $5,
       apply_error = NULL, render_mode_confirm = NULL, updated_at = now(),
       content = CASE WHEN $6::jsonb IS NOT NULL THEN content || jsonb_build_object('appliedFiles', $6::jsonb) ELSE content END
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, branchName, implementerId, renderMode, appliedFiles ? JSON.stringify(appliedFiles) : null]
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
       stage_merged_at = now(), apply_error = NULL, render_mode_confirm = NULL, updated_at = now(),
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
       apply_error = NULL, render_mode_confirm = NULL, updated_at = now(),
       rollback_snapshot = COALESCE($5, rollback_snapshot)
     WHERE site_id = $1 AND id = $2 AND status = 'branch_pushed'
     RETURNING *`,
    [siteId, id, prNumber, prUrl, rollbackSnapshot ? JSON.stringify(rollbackSnapshot) : null]
  );
  return rows[0] || null;
}

// Every draft still awaiting a merge confirmation for a given PR — a batch
// branch can carry several drafts sharing one PR number (see
// implementers/lib/github-ops.js's openPrForBranch), so a single "this PR
// merged" event (the GitHub webhook, server/routes/webhooks.js) must fan out
// to all of them, not just one. Scoped to status = 'pr_opened' so a draft
// that's already implemented (or never got this far) is never touched twice.
export async function listDraftsAwaitingPrCheck(siteId, prNumber) {
  const { rows } = await query(
    `SELECT * FROM drafts WHERE site_id = $1 AND pr_number = $2 AND status = 'pr_opened'`,
    [siteId, prNumber]
  );
  return rows;
}

// Pure annotation write, no status guard — same pattern as
// recordGscNotification below. Used by the Check PR Status action to record
// GitHub's real current PR state ('open'/'closed') when it hasn't merged
// yet; the 'merged' case instead goes through markDraftImplemented (below),
// since that's a real lifecycle transition, not just an annotation.
export async function recordPrState(siteId, id, prState, mergeableState = null) {
  const { rows } = await query(
    'UPDATE drafts SET pr_state = $3, pr_mergeable_state = $4, updated_at = now() WHERE site_id = $1 AND id = $2 RETURNING *',
    [siteId, id, prState, mergeableState]
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
export async function recordApplyFailure(siteId, id, errorMessage, renderModeInfo = null) {
  const { rows } = await query(
    `UPDATE drafts SET apply_error = $3, render_mode_confirm = $4, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, errorMessage, renderModeInfo ? JSON.stringify(renderModeInfo) : null]
  );
  return rows[0] || null;
}

// Every page on this site with a live, actually-applied visible FAQ block —
// render_mode is only ever set from markDraftBranchPushed onward, so this
// naturally only counts drafts with a real GitHub branch already pushed.
// Feeds the sitewide visible-FAQ cap in render-inspector.js's
// inspectRenderMode, so visible FAQ blocks stay selective across a site.
export async function countVisibleFaqDrafts(siteId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM drafts WHERE site_id = $1 AND action_type = 'faq' AND render_mode = 'visible'`,
    [siteId]
  );
  return rows[0].n;
}

// The true sitewide count the visible-FAQ cap must be checked against:
// pages this tool itself gave a visible FAQ (countVisibleFaqDrafts) PLUS
// pages that already had one organically before this tool ever ran
// (site.visible_faq_baseline, migration 074, set via the staff-triggered
// "Recalculate FAQ baseline" action). Using countVisibleFaqDrafts alone
// would let a site's total visible-FAQ pages exceed visible_faq_cap once
// any pre-existing organic FAQs are counted in.
export async function countVisibleFaqPages(site) {
  return (await countVisibleFaqDrafts(site.id)) + (site.visible_faq_baseline || 0);
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
// server/implementers/backend.js's MARKER_MERGE_TYPES + llms-txt +
// security-headers/html-lang, and server/implementers/frontend.js for
// landing-page/blog-outline/translation) — a real merge into stage is the
// ONLY path to 'implemented' for all 10. The legacy manual bypass below is
// kept only as an escape hatch for a draft whose type somehow isn't in this
// list (defensive, not expected to ever apply today).
export const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation', 'security-headers', 'html-lang', 'viewport', 'canonical', 'robots-fix', 'open-graph', 'broken-link-fix', 'redirect-fix', 'expand-content', 'sitemap'];

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
  if (draft) await supersedeLegacyLlmsTxtDrafts(siteId, draft);
  return draft;
}

// A single site-wide llms.txt draft (finding_id 'ai-visibility:site:llms-txt',
// see ai-visibility.js's llmsTxtFinding()) fully covers every page — once it
// ships, any older per-page llms-txt draft still sitting open (a leftover
// from before the dedup fix that introduced the site-wide finding) is
// permanently redundant and would otherwise sit in Action Center forever
// looking unresolved even though the real fix is already live. Narrowly
// scoped to llms-txt on purpose — not a general cross-action-type dedup
// engine.
async function supersedeLegacyLlmsTxtDrafts(siteId, draft) {
  if (draft.action_type !== 'llms-txt' || draft.finding_id !== 'ai-visibility:site:llms-txt') return;
  await query(
    `UPDATE drafts SET status = 'abandoned', abandoned_at = now(),
       abandoned_reason = 'superseded_by_site_wide_llms_txt', updated_at = now()
     WHERE site_id = $1 AND action_type = 'llms-txt'
       AND finding_id LIKE 'ai-visibility:%:Publish an llms.txt file%'
       AND status NOT IN ('implemented', 'abandoned')`,
    [siteId]
  );
}

// Terminal state for a draft whose fix never shipped — a PR closed without
// merging, or (see supersedeLegacyLlmsTxtDrafts above) another draft already
// fixed the same underlying issue. Excluded from getDraftedFindingIds below,
// so the underlying finding_id naturally reopens for buildRecommendations
// instead of staying silently locked out by a draft that never went live.
// Guarded like markDraftImplemented: never overwrites a real implemented
// draft, and idempotent against an already-abandoned one.
// abandonedBy is optional (undefined for the automatic pr_closed_without_
// merge/superseded call sites, which have no reviewing user) — the Phase 3
// "Reject" action (POST /action-center/drafts/:id/reject) is the one
// caller that passes it, for the same git-blame reason approvedBy exists.
export async function markDraftAbandoned(siteId, id, reason, abandonedBy) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'abandoned', abandoned_at = now(), abandoned_reason = $3,
       abandoned_by = $4, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status NOT IN ('implemented', 'abandoned')
     RETURNING *`,
    [siteId, id, reason, abandonedBy || null]
  );
  return rows[0] || null;
}

// submitted_for_approval -> revision_requested (Phase 3 approval workflow).
// Distinct from markDraftAbandoned above: the draft isn't dead, it needs
// author changes before another review pass — updateDraft (above) accepts
// edits from this state and flips it back to 'edited'. Appends to
// revision_history (a JSONB array) rather than overwriting a single
// column, so a draft that goes through multiple review rounds keeps every
// past reviewer/reason/timestamp, not just the latest.
export async function requestDraftRevision(siteId, id, { reviewerId, reason }) {
  const { rows } = await query(
    `UPDATE drafts
     SET status = 'revision_requested', updated_at = now(),
         revision_requested_at = now(), revision_requested_by = $3, revision_reason = $4,
         revision_history = revision_history || jsonb_build_array(
           jsonb_build_object('reviewer_id', $3::int, 'reason', $4::text, 'requested_at', now())
         )
     WHERE site_id = $1 AND id = $2 AND status = 'submitted_for_approval'
     RETURNING *`,
    [siteId, id, reviewerId || null, reason || null]
  );
  return rows[0] || null;
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

// Every finding_id with a draft in any non-abandoned status — a superset of
// getImplementedFindingIds above, since implemented is itself just one
// status among draft/edited/submitted_for_approval/approved/branch_pushed/
// merged_to_stage/pr_opened/implemented. Used by buildRecommendations to
// stop showing a recommendation the moment a draft exists for it, so it
// only ever shows in the Drafts tab from then on — not still in
// Recommendations too. Deleting a draft, or it becoming 'abandoned' (the fix
// never shipped — see markDraftAbandoned), naturally un-hides its finding
// again so a fresh draft can be generated.
export async function getDraftedFindingIds(siteId) {
  const { rows } = await query(
    "SELECT DISTINCT finding_id FROM drafts WHERE site_id = $1 AND finding_id IS NOT NULL AND status != 'abandoned'",
    [siteId]
  );
  return new Set(rows.map((r) => r.finding_id));
}

// Most recent NON-ABANDONED draft for a finding — used to make
// /action-center/generate idempotent so a retry, double-click, or a second
// browser tab can never create a second draft row for the same finding.
// Excludes 'abandoned' for the same reason getDraftedFindingIds above does:
// an abandoned draft's finding_id has already reopened for Recommendations,
// so a fresh generate call for it must actually regenerate (new LLM call,
// current content) instead of silently handing back the dead draft that
// never shipped.
export async function getDraftByFindingId(siteId, findingId) {
  const { rows } = await query(
    "SELECT * FROM drafts WHERE site_id = $1 AND finding_id = $2 AND status != 'abandoned' ORDER BY created_at DESC LIMIT 1",
    [siteId, findingId]
  );
  return rows[0] || null;
}
