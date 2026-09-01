// What an ALREADY-EXISTING draft means for a ship attempt.
//
// generateDraft is idempotent per finding: a retry returns the existing draft
// rather than billing a second LLM call. Both ship paths then have to answer
// the same question — "this draft isn't in 'draft'/'edited', so what now?" —
// and before this they answered it differently, both wrongly:
//
//   - auto-remediation.js threw "Draft was not in a submittable state",
//     counted it as a FAILURE, and fed CONSECUTIVE_FAILURE_LIMIT. Five of
//     those halt a site's entire run.
//   - routes/action-center.js's shipRecommendation short-circuited it as
//     `{ ok: true, alreadyShipped: true }` and marked the recommendation
//     'shipped' — which is right for a draft that really did land, and
//     actively misleading for one stranded at 'approved' by a failed apply(),
//     since it reports work as shipped that never reached GitHub at all.
//
// The distinction neither made is between a draft that is FINISHED and one
// that is STUCK PART-WAY. Live on site 1: 8 expand-content drafts sat at
// 'approved' with an apply_error since 2026-08-28 — the branch push had
// failed, nothing had ever re-run it, and each run re-picked the finding
// (getDraftedFindingIds treats an unresolved apply_error as "not handled",
// deliberately) only to reach the same dead end.
//
// Pure and side-effect free on purpose: it decides, the callers act.

export const SHIP_STATE = {
  // Nothing to do — this finding's work genuinely landed.
  SHIPPED: 'shipped',
  // apply() never succeeded. The content is generated, Quality-Gated and
  // approved; only the push failed, so re-run that rather than regenerate.
  RESUME_APPLY: 'resume-apply',
  // apply() succeeded and the commit exists; only the shared PR step is
  // outstanding, which the batch's finalizeBatchPr does for every pending
  // draft at once. Must be added to that pending list — treating it as
  // finished is what leaves a real commit with no PR ever opened.
  AWAITING_PR: 'awaiting-pr',
  // The normal path: submit -> approve -> apply.
  SUBMITTABLE: 'submittable',
  // Stuck in a state no automatic step can advance (a draft sent back for
  // human revision, or anything unrecognized). The repo's own recorded lesson
  // applies — never leave a partially-failed draft in a non-terminal status —
  // so the caller abandons it for a clean regeneration rather than retrying
  // into the same wall forever.
  STRANDED: 'stranded',
};

// 'implemented' means the PR merged; 'pr_opened' means the PR exists and a
// human owns it from here. Both are terminal as far as shipping is concerned.
const FINISHED_STATUSES = new Set(['implemented', 'pr_opened']);

export function draftShipState(draft) {
  if (!draft?.status) return SHIP_STATE.STRANDED;
  if (draft.status === 'draft' || draft.status === 'edited') return SHIP_STATE.SUBMITTABLE;
  if (FINISHED_STATUSES.has(draft.status)) return SHIP_STATE.SHIPPED;
  if (draft.status === 'branch_pushed') return SHIP_STATE.AWAITING_PR;
  // 'approved' is the stranded-by-failed-apply case above. Deliberately not
  // conditioned on apply_error being set: a draft that reached 'approved' and
  // stopped there did not push a branch either way, and re-running apply() is
  // the correct, idempotent response to both.
  if (draft.status === 'approved') return SHIP_STATE.RESUME_APPLY;
  return SHIP_STATE.STRANDED;
}
