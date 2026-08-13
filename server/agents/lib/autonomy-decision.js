// Formalizes the SAFE_TO_AUTO_EXECUTE / NEEDS_HUMAN_REVIEW / UNSAFE_REJECTED
// split (Phase 4, §2) that auto-remediation.js and Action Center already
// apply IMPLICITLY (risk_tier + blocked_reason), as one small, named,
// reusable function — not a second gating system.
//
// Every fact this reads already exists: `risk_tier` comes from
// riskTierForGenerator (risk-tiers.js), `blocked_reason` from the design-
// verification/url_file_map gate (recommendation-gates.js), `status` from
// the recommendation lifecycle (migration 110). This module adds no new
// gating logic — it names the decision the existing facts already imply, so
// auto-remediation.js's loop and the Assistant can both ask "what should
// happen to this?" through one function instead of re-deriving the answer
// (and risking disagreeing) in two places.

export const AUTONOMY_DECISION = {
  SAFE_TO_AUTO_EXECUTE: 'SAFE_TO_AUTO_EXECUTE',
  NEEDS_HUMAN_REVIEW: 'NEEDS_HUMAN_REVIEW',
  UNSAFE_REJECTED: 'UNSAFE_REJECTED',
};

// A recommendation that has already been ruled out. These never reach
// listOpenRecommendations in practice (status = 'open' is the query's own
// filter) — handled defensively here anyway, since this function's contract
// should hold for any recommendation row, not only ones a particular caller
// happened to fetch through that one query.
const REJECTED_STATUSES = new Set(['unfixable', 'dismissed', 'superseded']);

// rec: a recommendations row (or shape-compatible object) with at least
// { risk_tier, blocked_reason, status }. Never inspects generatorId-specific
// logic directly — that judgment belongs to risk-tiers.js alone.
//
// `learnedMap` (optional) is the Phase 5 extension point: a
// generatorId -> { demote, reason } map from
// generator-learning.js's getLearnedConfidenceMap. Passed in rather than
// fetched here so this function stays synchronous, pure, and cheap to call
// once per recommendation — a caller classifying many recommendations at
// once fetches the map ONCE, not per item. Omitting it (every pre-Phase-5
// call site, and every existing test) falls back to exactly the Phase 4
// behavior — learning is additive, never a prerequisite.
export function classifyRecommendation(rec, learnedMap = null) {
  if (!rec) return { decision: AUTONOMY_DECISION.UNSAFE_REJECTED, reason: 'no recommendation given' };

  if (REJECTED_STATUSES.has(rec.status)) {
    return { decision: AUTONOMY_DECISION.UNSAFE_REJECTED, reason: `recommendation status is '${rec.status}'` };
  }

  if (rec.blocked_reason) {
    // Blocked is a HUMAN-REVIEW state, not a rejection: the underlying issue
    // is real, it just cannot be safely drafted yet (an unresolved
    // url_file_map gap, an undesigned template, ...). The existing gate
    // already re-checks this automatically once the blocker clears — see
    // design-drift.js/recommendation-gates.js — so this is never a dead end,
    // only a pause.
    return { decision: AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW, reason: rec.blocked_reason };
  }

  if (rec.risk_tier === 'safe') {
    // Learning can only make the system MORE conservative, never less — it
    // can demote an otherwise-safe generator to human review on evidence of
    // repeated real-world failure, but it can never promote a manual-tier
    // generator to auto-execute. Safety boundaries (risk-tiers.js) are not
    // something outcome history gets a vote on.
    const learned = learnedMap?.get(rec.recommendation_type);
    if (learned?.demote) {
      return { decision: AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW, reason: `learned: ${learned.reason}` };
    }
    return { decision: AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE, reason: 'generator is in the safe tier and nothing is blocking it' };
  }

  return { decision: AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW, reason: `generator risk tier is '${rec.risk_tier || 'unknown'}', not safe` };
}

// Buckets a set of recommendation rows by decision — the shape both the
// autonomous loop's own pre-flight summary and the Assistant's "what's
// autonomous vs what needs me" view want, computed once rather than twice.
export function summarizeAutonomy(recs, learnedMap = null) {
  const buckets = { [AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE]: [], [AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW]: [], [AUTONOMY_DECISION.UNSAFE_REJECTED]: [] };
  for (const rec of recs || []) {
    const { decision, reason } = classifyRecommendation(rec, learnedMap);
    buckets[decision].push({ id: rec.id, type: rec.recommendation_type, issue: rec.issue, page: rec.page ?? rec.params?.page ?? null, reason });
  }
  return {
    safeToAutoExecute: buckets[AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE],
    needsHumanReview: buckets[AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW],
    unsafeRejected: buckets[AUTONOMY_DECISION.UNSAFE_REJECTED],
  };
}
