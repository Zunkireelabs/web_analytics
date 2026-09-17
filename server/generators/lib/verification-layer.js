// Shared pre-flight verification contract — the DISCOVER -> VERIFY_CURRENT_STATE
// stage every generator can plug into before the shared pipeline decides
// whether to (re)generate a draft, spend a retry/recovery cycle, or give up.
//
// This does NOT replace the decision layers that already exist:
//   - recommendation-gates.js   — pre-creation gates (drop / blockedReason)
//   - attempt-classification.js — post-failure retry policy
//   - autonomy-decision.js      — risk/status -> who is allowed to act
//   - fix-verification.js       — post-ship live re-check
// It fills the gap those four don't cover: a safe, side-effect-free re-check
// of whether a recommendation's own premise still holds, run BEFORE a fix is
// (re)attempted. A generator with no verifier keeps exactly today's
// behavior — `still_valid`, no evidence — since assuming otherwise without a
// real check would itself be the kind of guess this framework exists to
// avoid.
//
// Contract (documentation-only, mirrors generators/types.js's discipline):
//   export async function verifyCurrentState(rec, ctx) -> Promise<{
//     decision: one of VERIFICATION_DECISION,
//     reason:   short machine-readable code, generator-specific,
//     evidence: whatever real evidence was inspected (repo content, live
//               HTML, search results, ...) — never fabricated, never guessed.
//   }>
// `rec` is a recommendations-table row (or any object with the same
// .recommendation_type / .params shape); `ctx` carries whatever the caller
// already has on hand (typically { site }) so the generator never has to
// re-fetch what its caller already loaded.

import { getGenerator } from '../registry.js';

export const VERIFICATION_DECISION = Object.freeze({
  ALREADY_RESOLVED: 'already_resolved',
  STILL_VALID: 'still_valid',
  NEEDS_UPDATE: 'needs_update',
  OBSOLETE: 'obsolete',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  UNSAFE: 'unsafe',
  NEEDS_HUMAN: 'needs_human',
});

const VALID_DECISIONS = new Set(Object.values(VERIFICATION_DECISION));

// Re-inspects reality for one recommendation and returns a normalized
// decision. Never throws — a verification failure (network blip, transient
// GitHub error) is not evidence about the recommendation itself, so it falls
// back to `still_valid` with the error attached as evidence, the same
// fail-safe behavior action-center-reconciler.js's own re-check try/catches
// already apply by hand for broken-link-fix.
export async function verifyRecommendation(rec, ctx = {}) {
  const generator = await getGenerator(rec.recommendation_type);
  if (!generator || typeof generator.verifyCurrentState !== 'function') {
    return { decision: VERIFICATION_DECISION.STILL_VALID, reason: 'no-verifier-available', evidence: null };
  }
  try {
    const result = await generator.verifyCurrentState(rec, ctx);
    if (!result || !VALID_DECISIONS.has(result.decision)) {
      throw new Error(`verifyCurrentState for "${rec.recommendation_type}" returned an invalid decision: ${result?.decision}`);
    }
    return result;
  } catch (err) {
    return { decision: VERIFICATION_DECISION.STILL_VALID, reason: 'verification-error', evidence: { error: err.message } };
  }
}

// True only for the one decision every caller can safely act on without any
// generator-specific branching: nothing to fix, close it, don't spend a
// retry/recovery cycle. Every other decision needs the caller to know its
// own domain (e.g. how "needs_human" should be surfaced) rather than being
// generalized here.
export function isAlreadyResolved(verification) {
  return verification?.decision === VERIFICATION_DECISION.ALREADY_RESOLVED;
}
