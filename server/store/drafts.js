import { query } from '../db.js';
import { isVerifiableDraft, createPendingVerification, getWatchlistItemByFindingId } from './fix-verifications.js';
import { sanitizeForCustomer } from '../lib/errors.js';

// CRUD for the drafts table, plus its approval lifecycle:
// draft/edited -> submitted_for_approval -> approved -> implemented. There's
// still no CMS integration to push content to — "implemented" means a
// person put the approved content live on the real site and told the
// dashboard so, the same real-evidence pattern hasDraftSince() already
// leans on for the Watchlist, one step further along.

export async function createDraft(siteId, { actionType, source, findingOrigin, input, content, findingId, gateResolvedPatterns, renderedBody, targetFilePath, memoryRefId }) {
  // original_content (migration 091) is the generator's first output,
  // frozen here and never touched again — updateDraft below only ever
  // writes `content`, so a later diff of the two is how
  // auto-remediation.js's approval-time lesson extraction knows whether a
  // human corrected this draft before approving it. gate_resolved_patterns
  // (migration 093) is which validation-rule hits this generation needed a
  // self-correction for, if any — see generateDraft's learning-system
  // comment (routes/action-center.js) for how approveAndPublishDraft later
  // confirms it. renderedBody/targetFilePath (migration 095) are the
  // generation-time-precomputed, rendering-gate-validated final output for
  // net-new-content action types — see frontend.js's resolveTargetAndBody
  // fast path for how they're consumed at apply/preview time. Both null for
  // an action type this doesn't apply to (marker-merge types, which must
  // still compute their splice fresh against the live file at apply time).
  try {
    const { rows } = await query(
      `INSERT INTO drafts (site_id, action_type, source, finding_origin, input, content, original_content, finding_id, gate_resolved_patterns, rendered_body, target_file_path, memory_ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [siteId, actionType, source ?? null, findingOrigin ?? null, JSON.stringify(input ?? {}), JSON.stringify(content), findingId || null, gateResolvedPatterns || null, renderedBody ?? null, targetFilePath ?? null, memoryRefId ?? null]
    );
    return rows[0];
  } catch (err) {
    // drafts_site_finding_id_unique (migration 118) — the DB-level backstop
    // for generateDraft()'s app-level getDraftByFindingId-then-insert check.
    // That check-then-insert has a real window (up to two LLM generation
    // attempts, the Quality Gate, and Design Agent resolution can all run
    // between the read and this insert), which the two Analyst->Node paths
    // (drafts.py's direct MCP push and auto-remediation.js's recommendation
    // pull) can both fall into for the same finding_id. A losing concurrent
    // insert here is not a real failure — the winner's row already
    // represents this finding — so return it exactly as the app-level check
    // would have, instead of throwing a duplicate-key error up to the caller.
    if (err.code === '23505' && err.constraint === 'drafts_site_finding_id_unique' && findingId) {
      const existing = await getDraftByFindingId(siteId, findingId);
      if (existing) return existing;
    }
    throw err;
  }
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
//
// rendered_body/target_file_path (migration 095) are always cleared here —
// a human editing `content` invalidates whatever was precomputed from the
// OLD content at generation time; frontend.js's resolveTargetAndBody falls
// through to a fresh, correct recompute the moment either is NULL, so an
// edited draft is never applied using stale pre-edit output.
export async function updateDraft(siteId, id, { content }) {
  const { rows } = await query(
    `UPDATE drafts SET content = $1, status = 'edited', updated_at = now(), rendered_body = NULL, target_file_path = NULL
     WHERE site_id = $2 AND id = $3 AND status IN ('draft', 'edited', 'revision_requested')
     RETURNING *`,
    [JSON.stringify(content), siteId, id]
  );
  return rows[0] || null;
}

// Guarded like every other draft-mutating function above — an 'implemented'
// draft is the only record that a real, live production change came from
// this app at all (the file change itself lives on in the merged GitHub PR
// regardless, but THIS row is the only link back to which draft/finding
// produced it). Deleting it destroys that audit trail for no operational
// benefit: an implemented draft is terminal and isn't blocking anything a
// discard would unblock. DraftModal.jsx already hides the Discard button
// once a draft is implemented, but that's UI-only — this is the real
// boundary, enforced for every caller (API route, MCP tool, script alike).
export async function deleteDraft(siteId, id) {
  const { rowCount } = await query(
    `DELETE FROM drafts WHERE site_id = $1 AND id = $2 AND status != 'implemented'`,
    [siteId, id]
  );
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
// targetProvenance is page-resolution.js's resolvePageSource() output for
// this draft's target — what actually renders the page, whether that's
// shared, and what editing it would affect. null for anything the caller
// couldn't or didn't resolve (e.g. site-level generators with no single
// page), same as appliedFiles above.
export async function markDraftBranchPushed(siteId, id, { branchName, implementerId, renderMode = null, appliedFiles = null, targetProvenance = null }) {
  const { rows } = await query(
    `UPDATE drafts SET status = 'branch_pushed', branch_name = $3, implementer_id = $4, render_mode = $5,
       apply_error = NULL, render_mode_confirm = NULL, updated_at = now(),
       content = CASE WHEN $6::jsonb IS NOT NULL THEN content || jsonb_build_object('appliedFiles', $6::jsonb) ELSE content END,
       target_provenance = COALESCE($7::jsonb, target_provenance)
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, branchName, implementerId, renderMode, appliedFiles ? JSON.stringify(appliedFiles) : null, targetProvenance ? JSON.stringify(targetProvenance) : null]
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

// Pure annotation write, shallow-merged (Postgres `||`) rather than
// overwritten — the Approval Gate (routes/lib/approval-gate.js) has more
// than one writer for this one column over a draft's lifecycle:
// approveAndPublishDraft writes `qualityGate`/`renderingConfig`
// synchronously at approval time, checkDraftPrStatus writes `clientBuild`
// later, asynchronously, once a real PR/check exists. A full-row overwrite
// here would let whichever call lands second silently erase the other's
// result — the shallow merge means each caller only ever touches the
// top-level key(s) it actually knows about. Same no-status-guard,
// annotation-only shape as recordPrState/recordGscNotification above: this
// never represents a lifecycle transition on its own.
export async function recordValidationStatus(siteId, id, partial) {
  const { rows } = await query(
    `UPDATE drafts SET validation_status = COALESCE(validation_status, '{}'::jsonb) || $3::jsonb, updated_at = now()
     WHERE site_id = $1 AND id = $2
     RETURNING *`,
    [siteId, id, JSON.stringify({ ...partial, checkedAt: new Date().toISOString() })]
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
// Defense-in-depth net (server/lib/errors.js) right at the boundary this
// column is rendered from verbatim (web/src/components/DraftModal.jsx's
// "Deployment Attempt Failed" banner) — every known caller already builds a
// sanitized message before reaching here, but this is the one place that
// stops a future caller's mistake from ever reaching the customer, not just
// today's known call sites.
export async function recordApplyFailure(siteId, id, errorMessage, renderModeInfo = null) {
  const safeError = sanitizeForCustomer(errorMessage, 'This change could not be applied — our team has been notified.');
  const { rows } = await query(
    `UPDATE drafts SET apply_error = $3, render_mode_confirm = $4, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [siteId, id, safeError, renderModeInfo ? JSON.stringify(renderModeInfo) : null]
  );
  return rows[0] || null;
}

// Both action types render their own visible accordion-style Q&A block
// (see render-inspector.js's INSPECTABLE_ACTION_TYPES comment) and so both
// count against the same sitewide visible-FAQ cap/dedup — a page that
// already has one from either mechanism must not get a second one from the
// other. Shared by every query below that used to check 'faq' alone.
const VISIBLE_FAQ_ACTION_TYPES = ['faq', 'qa-content'];

// Every page on this site with a live, actually-applied visible FAQ block —
// render_mode is only ever set from markDraftBranchPushed onward, so this
// naturally only counts drafts with a real GitHub branch already pushed.
// Feeds the sitewide visible-FAQ cap in render-inspector.js's
// inspectRenderMode, so visible FAQ blocks stay selective across a site.
export async function countVisibleFaqDrafts(siteId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM drafts WHERE site_id = $1 AND action_type = ANY($2::text[]) AND render_mode = 'visible'`,
    [siteId, VISIBLE_FAQ_ACTION_TYPES]
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
//
// Purely historical — a page counted here forever counts, even if its
// visible FAQ was later removed (a manual edit, a revert, a redesign
// outside this tool). implementers/lib/faq-render-mode.js's
// countCurrentlyVisibleFaqPages is the live-state-verified version of this
// same total, and is what actually gates new visible-FAQ decisions —
// this function stays as the cheap/instant hint path and for any caller
// that only needs the historical figure, not a real-time cap check.
export async function countVisibleFaqPages(site) {
  return (await countVisibleFaqDrafts(site.id)) + (site.visible_faq_baseline || 0);
}

// One row per page this tool ever pushed a visible FAQ to (see
// countVisibleFaqDrafts above for why render_mode = 'visible' alone is
// enough to mean "a real branch was pushed") — the candidate set
// faq-render-mode.js's countCurrentlyVisibleFaqPages re-checks against each
// page's CURRENT live content, since a historical push is not proof the FAQ
// is still there today.
export async function distinctVisibleFaqDraftPages(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT COALESCE(content->>'page', input->>'page') AS page
     FROM drafts
     WHERE site_id = $1 AND action_type = ANY($2::text[]) AND render_mode = 'visible'
       AND COALESCE(content->>'page', input->>'page') IS NOT NULL`,
    [siteId, VISIBLE_FAQ_ACTION_TYPES]
  );
  return rows.map((r) => r.page);
}

// Cross-mechanism duplicate guard for lib/faq-render-mode.js: marker-merge
// (an HTML splice into a template file) and the data-array-content adapter
// (writing into a data file the site's own component renders) are two
// independent ways a page can end up with a visible FAQ, and neither can see
// the other's published output by scanning file content alone — a data
// file's raw JSON has no HTML signal, and a template that renders from a
// data file at build time may have no FAQ-shaped markup in its own source at
// all. The drafts table is the one place both mechanisms' history is
// visible, so this is checked before either one decides to publish a new
// visible FAQ for the same page.
//
// Deliberately NOT `status = 'implemented'` — two sibling drafts from the
// SAME daily batch (e.g. a 'qa-content' and a 'faq' draft both targeting the
// same page) each get their render-mode decision at apply/branch-push time,
// well before either reaches 'implemented' (that only happens once the whole
// batch PR merges to stage, often hours later). A prior version of this
// query only matched 'implemented' rows, so at decision time neither sibling
// could see the other yet, and both independently concluded "no visible FAQ
// exists" — this is exactly how zunkireelabs.com's index page ended up with
// two visible Q&A blocks in the same PR (drafts #113 qa-content + #114 faq,
// both approved ~90s apart, both 'implemented' only ~2.5h later at merge).
// `render_mode` is only ever set once a real branch has been pushed for the
// draft (see countVisibleFaqDrafts above), so `render_mode = 'visible'`
// alone is already proof this draft has committed to publishing visible
// content for this page — status can be anything from 'branch_pushed'
// onward. Only exclude drafts whose visible publish was later undone:
// abandoned outright, or rolled back after going live.
export async function hasImplementedVisibleFaqForPage(siteId, page) {
  if (!page) return false;
  const { rows } = await query(
    `SELECT 1 FROM drafts
     WHERE site_id = $1 AND action_type = ANY($3::text[]) AND render_mode = 'visible'
       AND status <> 'abandoned' AND rolled_back_at IS NULL
       AND (content->>'page' = $2 OR input->>'page' = $2)
     LIMIT 1`,
    [siteId, page, VISIBLE_FAQ_ACTION_TYPES]
  );
  return rows.length > 0;
}

// Same retryable-in-place pattern as recordApplyFailure, for a
// mergeToStage() failure (e.g. a real merge conflict) — the branch itself
// is already real/pushed at this point, only the merge call failed, so this
// stays at branch_pushed rather than reverting anything.
export async function recordMergeFailure(siteId, id, errorMessage) {
  const safeError = sanitizeForCustomer(errorMessage, 'This pull request could not be opened — our team has been notified.');
  const { rows } = await query(
    `UPDATE drafts SET apply_error = $3, updated_at = now()
     WHERE site_id = $1 AND id = $2 AND status = 'branch_pushed'
     RETURNING *`,
    [siteId, id, safeError]
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
export const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation', 'security-headers', 'html-lang', 'viewport', 'canonical', 'robots-fix', 'open-graph', 'broken-link-fix', 'redirect-fix', 'expand-content', 'qa-content', 'analytics-install', 'sitemap', 'cookie-policy', 'privacy-policy', 'terms-of-service', 'breadcrumbs', 'schema-repair', 'alt-text'];

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
      // finding_origin (migration 119) carries the real detecting agent
      // through any shipping mechanism (auto-remediation/execution-engine
      // both overwrite draft.source with their own mechanism label) — fall
      // back to source for rows created before that column existed, or for
      // callers that never had a separate origin to record.
      source: draft.finding_origin || draft.source,
      memoryRefId: draft.memory_ref_id ?? null,
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

// How many drafts a given source has created for this site since the start of
// today IN THE SITE'S OWN TIMEZONE — the daily budget the unattended
// auto-remediation loop spends against (agents/lib/auto-remediation.js).
//
// The timezone matters and is not decoration: sites.timezone defaults to
// Asia/Kolkata while the server may run anywhere, so counting against UTC
// midnight would roll the budget over mid-afternoon for an Indian client and
// let a single day ship close to two full budgets. `AT TIME ZONE $3` does the
// conversion in Postgres against the same clock the row was written with,
// rather than reconstructing a local midnight in JS and hoping the two agree
// across a DST boundary.
//
// Counts every draft the source created today regardless of what became of it
// (shipped, failed at apply, abandoned): the budget is a cap on how much
// unattended WORK the system does per day, not on how much of it succeeded —
// otherwise a site failing every attempt would retry without limit, which is
// exactly the runaway the cap exists to prevent.
export async function countDraftsBySourceToday(siteId, source, timezone = 'UTC') {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM drafts
      WHERE site_id = $1 AND source = $2
        AND (created_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date`,
    [siteId, source, timezone]
  );
  return rows[0]?.n ?? 0;
}

// Same shape as countDraftsBySourceToday, summed across every site — backs
// job.js's optional AUTO_REMEDIATION_GLOBAL_DAILY_CEILING. Per-site budgets
// each use their own timezone (a site's "today" is meaningful to that
// site's own publishing rhythm); a cross-site total has no single site's
// timezone to prefer, so this uses UTC as a fixed, if slightly coarse,
// "today" for the platform-wide ceiling — a blunt additional safety net on
// top of the precise per-site budgets, not a replacement for them.
export async function countDraftsBySourceTodayAllSites(source) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM drafts
      WHERE source = $1 AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`,
    [source]
  );
  return rows[0]?.n ?? 0;
}

// Whether a draft of `actionType` was created for this site within the last
// `days` days — the evidence behind auto-remediation.js's publishing-cadence
// gap (sites.blog_min_gap_days, migration 107).
//
// Deliberately counts drafts from ANY source, not just 'auto-remediation'.
// The gap exists so the site publishes at a believable rhythm, and a reader
// or a crawler cannot tell whether a post was triggered by the unattended
// loop or by a human clicking Execute Today's Safe Fixes. A human who ships
// a blog manually today has already used this window; the agent respecting
// that is the point, and the human stays free to ship again immediately
// because this gap is only ever consulted by the unattended path.
//
// Abandoned drafts don't count — an abandoned post was never published, so
// it should not hold the window open against a real one.
export async function hasRecentDraftOfType(siteId, actionType, days, timezone = 'UTC') {
  if (!days || days <= 0) return false;
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM drafts
        WHERE site_id = $1 AND action_type = $2 AND status <> 'abandoned'
          AND (created_at AT TIME ZONE $4)::date > (now() AT TIME ZONE $4)::date - $3::int
     ) AS found`,
    [siteId, actionType, days, timezone]
  );
  return Boolean(rows[0]?.found);
}

// Every finding_id with at least one implemented draft — finding ids are
// stable slugs (e.g. `content-gap:<page>:Missing FAQ`, see agents/types.js),
// so this reliably answers "already shipped" even though the underlying
// agent re-derives the same finding fresh on its next scheduled run.
// Used by buildRecommendations (agents/lib/recommendations.js) to stop
// resurfacing a finding in the Findings List once its fix is actually live,
// instead of waiting on the next agent run to naturally stop re-detecting it.
// Also feeds Website Health's implementedFindingIds (job.js -> health-score.js)
// and the Growth report/summary — so a finding excluded here is treated
// everywhere as genuinely resolved, not merely "PR merged".
//
// "implemented" itself is real evidence (a merged PR, see markDraftImplemented
// above) that the fix shipped — but shipping isn't the same as the fix
// actually working (wrong file patched, a silently failed deploy, an edge
// case the generator missed). For the subset of drafts fix-verification.js
// can re-check (isVerifiableDraft), a LATERAL join pulls each finding's most
// recent non-pending verification outcome; a finding whose latest real
// re-check still found the issue live is excluded here even though its
// draft says 'implemented', so it re-surfaces in Recommendations and the
// next scheduled health-score run correctly re-penalizes it instead of
// silently staying "fixed" forever. Findings with no verification history
// (unverifiable draft types) are unaffected — COALESCE lets them pass
// through exactly as before.
export async function getImplementedFindingIds(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT d.finding_id
     FROM drafts d
     LEFT JOIN LATERAL (
       SELECT fv.outcome FROM fix_verifications fv
       WHERE fv.site_id = d.site_id AND fv.finding_id = d.finding_id AND fv.outcome != 'pending'
       ORDER BY fv.checked_at DESC NULLS LAST
       LIMIT 1
     ) latest_verification ON true
     WHERE d.site_id = $1 AND d.status = 'implemented' AND d.finding_id IS NOT NULL
       AND COALESCE(latest_verification.outcome, 'verified-fixed') != 'still-present'`,
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
//
// Also excludes a draft with an unresolved apply_error (a push-branch/PR
// attempt that failed and hasn't succeeded since — recordApplyFailure sets
// this, every successful state transition clears it back to NULL). Without
// this, a draft stuck on a real deployment failure hides its finding from
// Recommendations forever with no way back to it short of already knowing
// to check the Drafts tab — confirmed as a real report: a site owner whose
// Cookie Policy draft failed to push yesterday had no "Generate" button to
// click today, since the finding had silently vanished from Recommendations.
// getDraftByFindingId (used by the idempotent /generate route) still finds
// this same stuck draft by finding_id regardless, so re-surfacing the
// finding here just gives the user a real way back into it — never creates
// a duplicate draft row.
export async function getDraftedFindingIds(siteId) {
  const { rows } = await query(
    "SELECT DISTINCT finding_id FROM drafts WHERE site_id = $1 AND finding_id IS NOT NULL AND status != 'abandoned' AND rolled_back_at IS NULL AND apply_error IS NULL",
    [siteId]
  );
  return new Set(rows.map((r) => r.finding_id));
}

// How many times each finding has already been drafted and then abandoned
// for a reason that says the item itself cannot be shipped — the input to
// the convergence cap (agents/lib/ship-pacing.js).
//
// The churn this measures is a direct consequence of getDraftedFindingIds
// above: abandoning a draft deliberately un-hides its finding so it can be
// retried. That is right for a transient failure and wrong for a permanent
// one, and nothing distinguished them. Measured on site 1 over three days:
// 623 drafts for 496 distinct findings, with single findings redrafted up to
// TEN times — `trust-compliance:facebook-pixel:missing` (10x), a geo-signals
// question-headings item (9x), "already has an FAQPage schema" (24 attempts
// across 6 findings). Every cycle spends an LLM generation plus a handful of
// GitHub calls to reach the identical failure.
//
// Only ITEM-SPECIFIC failures count. Everything excluded below is a property
// of the infrastructure or of a human decision, and counting any of it would
// retire findings that have nothing wrong with them — the exact opposite of
// the goal:
//   - 'pr_closed_without_merge' / 'superseded': a human closed the PR or the
//     work was replaced. The draft was fine; the decision was elsewhere.
//     (This is the single largest bucket — 176 drafts from one closed PR.)
//   - anything naming a rate limit: transient by definition.
//   - 'Batch push/PR failed%': the batch's ONE shared push/PR failed, which
//     fails every pending item at once regardless of their content. On
//     2026-09-01 that abandoned 54 drafts in a single call — and crucially
//     their text is sanitized ("This pull request could not be opened right
//     now — our team has been notified. (ref: …)"), so it does NOT match the
//     rate-limit filter above even when a rate limit was the true cause.
//     Without this line the cap would hold precisely the findings this work
//     exists to rescue.
//   - 'Stuck at "…"%': the draft-state reset (lib/draft-ship-state.js), which
//     is a bookkeeping action taken to allow a clean retry, not a verdict on
//     whether the item can be fixed.
//
// Windowed to 30 days so a finding that failed repeatedly months ago, under
// long-since-changed code, is not retired forever on that evidence.
export async function countFailedAttemptsByFinding(siteId) {
  const { rows } = await query(
    `SELECT finding_id, COUNT(*)::int AS attempts
       FROM drafts
      WHERE site_id = $1 AND finding_id IS NOT NULL AND status = 'abandoned'
        AND abandoned_reason IS NOT NULL
        AND abandoned_at > now() - interval '30 days'
        AND abandoned_reason NOT IN ('pr_closed_without_merge', 'superseded')
        AND abandoned_reason NOT ILIKE '%rate limit%'
        AND abandoned_reason NOT LIKE 'Batch push/PR failed%'
        AND abandoned_reason NOT LIKE 'Stuck at "%'
      GROUP BY finding_id`,
    [siteId]
  );
  return new Map(rows.map((r) => [r.finding_id, r.attempts]));
}

// The file-level sibling to getDraftedFindingIds above: that function stops
// the SAME finding_id from being redrafted, but says nothing about a
// DIFFERENT finding targeting the same physical file while an earlier
// finding's draft for that file still has an open, unmerged PR sitting on a
// still-open Action Center batch branch (github-ops.js's batchBranchName is
// strictly day-keyed and never chains off a prior day's branch — a real,
// documented tradeoff, not a bug). Without this, a second day's batch
// independently regenerates the same file from stale content, producing
// wasted/conflicting drafts (confirmed live: a page's title flipped back and
// forth across two days' unmerged PRs, and a second FAQ schema block landed
// on top of a first still-pending one). Scoped to status = 'pr_opened' AND
// pr_state = 'open' specifically — a draft that's still 'draft'/'edited'
// (not yet pushed) has nothing on GitHub to collide with yet, and pr_state
// flips away from 'open' the moment its PR merges or closes (see
// markDraftPrOpened/recordPrState below), freeing the file up automatically
// with no separate cleanup needed.
export async function getPendingDraftFilePaths(siteId) {
  const { rows } = await query(
    "SELECT DISTINCT target_file_path FROM drafts WHERE site_id = $1 AND target_file_path IS NOT NULL AND status = 'pr_opened' AND pr_state = 'open' AND rolled_back_at IS NULL",
    [siteId]
  );
  return new Set(rows.map((r) => r.target_file_path));
}

// Marks a draft as rolled back without touching its real status column —
// unlike markDraftAbandoned, this must work on 'implemented'/'merged_to_stage'
// drafts too (that's exactly when rollback is available), and 'implemented'
// staying 'implemented' is correct: it genuinely did go live. rolled_back_at
// is what getDraftedFindingIds above checks to reopen the finding again.
export async function markDraftRolledBack(siteId, id) {
  const { rows } = await query(
    'UPDATE drafts SET rolled_back_at = now(), updated_at = now() WHERE site_id = $1 AND id = $2 RETURNING *',
    [siteId, id]
  );
  return rows[0] || null;
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
