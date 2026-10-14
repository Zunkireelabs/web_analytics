// Advance a decision through the lifecycle migration 166 defined and
// nothing ever used.
//
// decisions.status was built as decided → executing → shipped → verified,
// with 'failed' as the other terminal state, and outcome_ref documented as
// the forward link to fix_impact. In practice every row sat at 'decided'
// forever: setDecisionOutcome had one caller, which deliberately keeps the
// status at 'decided' for an escalation.
//
// Why that matters, concretely: an engine that records what it decided but
// never what happened cannot distinguish a decision that shipped and worked
// from one that shipped and made things worse. Both look identical in the
// table. Everything needed to tell them apart is already measured —
// fix_impact computes real before/after Search Console windows at :40,
// generator_outcomes records every attempt — it was simply never connected
// back. Until it is, "the engine learns from its own decisions" is a label.
//
// This module is deliberately tiny and does no reasoning. It is the one
// place that knows the state order, so no caller can invent a transition.

export const DECISION_STATUSES = Object.freeze(['decided', 'executing', 'shipped', 'verified', 'failed']);

// Forward progress only. 'failed' is reachable from anywhere, because a ship
// can fail at any stage; 'verified' and 'failed' are terminal.
const RANK = Object.freeze({ decided: 0, executing: 1, shipped: 2, verified: 3 });
const TERMINAL = new Set(['verified', 'failed']);

// Whether a transition is real progress. Separated out and pure so the one
// rule that protects the table is directly testable.
//
// The guard exists because these transitions arrive from five independent
// cron lanes with no ordering between them: the :20 PR poll can observe a
// merge in the same hour the :10 verification lane already recorded a
// result, and the shipping queue can re-enqueue a retry after a ship was
// recorded. Without this, a late-arriving earlier stage would walk a
// verified decision backwards and the table would stop meaning anything.
export function canAdvance(from, to) {
  if (!DECISION_STATUSES.includes(to)) return false;
  if (from === to) return false;
  if (TERMINAL.has(from)) return false;
  if (to === 'failed') return true;
  return (RANK[to] ?? -1) > (RANK[from] ?? -1);
}

const DEFAULT_DEPS = {
  // Imported lazily for the same reason lib/tenant-context.js does it: this
  // module is called from cron lanes and route handlers whose tests mock the
  // store with a partial set of named exports.
  load: null,
};

async function deps(override = {}) {
  if (override.getDecision && override.setOutcome) return { ...DEFAULT_DEPS, ...override };
  const store = await import('../../store/decisions.js');
  return {
    getDecision: store.getDecision,
    setOutcome: store.setDecisionOutcome,
    decisionIdForRecommendation: store.getDecisionIdForRecommendation,
    ...override,
  };
}

/**
 * Advance one decision. Returns the updated row, or null when nothing
 * changed — including when the transition was refused as a regression.
 *
 * Never throws. A decision's bookkeeping must not be able to fail a ship:
 * the recommendation, the draft and the PR are the real work, and this is
 * the record of why it happened.
 */
export async function advanceDecision(decisionId, status, { outcomeRef = null, deps: injected = {} } = {}) {
  if (!decisionId) return null;
  try {
    const d = await deps(injected);
    const current = await d.getDecision(decisionId);
    if (!current) return null;
    if (!canAdvance(current.status, status)) {
      // Still record an outcome_ref that arrived late, even when the status
      // cannot move — the link forward to fix_impact is the point, and a
      // verified decision that never got its reference is the one case where
      // the loop closes in the table but not in the data.
      if (outcomeRef && !current.outcome_ref) {
        return await d.setOutcome(decisionId, { status: current.status, outcomeRef });
      }
      return null;
    }
    return await d.setOutcome(decisionId, { status, outcomeRef });
  } catch (err) {
    console.warn(`[decision-lifecycle] could not advance decision ${decisionId} to ${status}: ${err.message}`);
    return null;
  }
}

// What the ship path actually has in hand. A recommendation produced by a
// DEFAULT-bucket decision carries decision_id (173); every other
// recommendation carries NULL and this is a no-op, which is the common case
// and must cost one indexed lookup, not a thrown error.
export async function advanceDecisionForRecommendation(recommendationId, status, { outcomeRef = null, deps: injected = {} } = {}) {
  if (!recommendationId) return null;
  try {
    const d = await deps(injected);
    const decisionId = await d.decisionIdForRecommendation(recommendationId);
    if (!decisionId) return null;
    return await advanceDecision(decisionId, status, { outcomeRef, deps: injected });
  } catch (err) {
    console.warn(`[decision-lifecycle] could not resolve a decision for recommendation ${recommendationId}: ${err.message}`);
    return null;
  }
}

// The fix_impact reference format, in one place so the reader and the writer
// cannot drift. outcome_ref is TEXT by design (166) — it points at different
// tables at different stages.
export const outcomeRefForFixImpact = (fixImpactId) => (fixImpactId ? `fix_impact:${fixImpactId}` : null);
export const outcomeRefForDraft = (draftId) => (draftId ? `drafts:${draftId}` : null);
