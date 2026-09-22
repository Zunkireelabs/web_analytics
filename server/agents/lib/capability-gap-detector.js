import { listDrafts } from '../../store/drafts.js';
import { classifyAbandonReason, RETRY_POLICY } from '../../lib/attempt-classification.js';

// Phase 5 of the "one intelligence" consolidation plan (fix/system) —
// same-site failure CLUSTERING, which is genuinely new. Confirmed by audit
// that learned-repair.js already solves a related but different problem
// (cross-CLIENT repair reuse via site-fingerprint matching), and
// failure-policy.js's classifyShipFailure already correctly stops ONE
// systemic fault (e.g. a dead repo token) from blocking a whole run's worth
// of unrelated items — neither one asks "do many of THIS site's own
// per-item failures share one repairable root cause", which is the literal
// "22 failures = one resolver capability gap, not 22 separate problems"
// shape the plan calls for.
//
// Built entirely on top of attempt-classification.js's existing, closed-set
// classification rather than any new text matching: classifyAbandonReason's
// `summary` field is already a generalized, deduplicated category (the rule
// that matched, not the raw error string), and its `retryPolicy` already
// identifies exactly the failure shape worth clustering —
// RETRY_POLICY.ITEM_DEFECT, defined in that module as "a real, item-specific
// defect that will recur identically until the item itself changes". A
// RETRY/NEEDS_HUMAN/ALREADY_RESOLVED/NEVER failure is not a capability gap
// (transient, config-gated, already resolved, or a human's own decision) —
// only ITEM_DEFECT clusters here.
//
// Detection-only, deliberately: this module reads `drafts` and returns
// candidate CapabilityGap objects. It does not pause anything, does not
// change any draft's status, and is not called from the real reconcile
// pass yet — wiring a detected gap into "pause further individual retries
// pending a repair" is later, explicit work, same unwired-until-reviewed
// discipline as every other module added in this plan.

export const CLUSTER_THRESHOLD = 3;

// How far back to scan per detection pass. Bounded rather than "all
// history" for the same reason listDraftsForBoard caps 'implemented' rows
// (store/drafts.js) — abandoned-draft history for an active site grows
// without bound, and a capability gap worth repairing is a RECENT, still-
// recurring pattern, not something first seen a year ago.
export const LOOKBACK_LIMIT = 200;

// `deps` is injectable (same createX(deps) shape as every other module this
// plan added) for unit testing without a real DB.
export function createCapabilityGapDetector({
  listDraftsFn = listDrafts,
  classifyAbandonReasonFn = classifyAbandonReason,
} = {}) {
  async function detectCapabilityGaps(siteId, { threshold = CLUSTER_THRESHOLD } = {}) {
    const abandoned = await listDraftsFn(siteId, { status: 'abandoned', limit: LOOKBACK_LIMIT });
    const clusters = new Map();

    for (const draft of abandoned) {
      const { failureClass, retryPolicy, summary } = classifyAbandonReasonFn(draft.abandoned_reason);
      if (retryPolicy !== RETRY_POLICY.ITEM_DEFECT) continue;

      // Clustered by (generator, generalized failure summary) — NOT by raw
      // abandoned_reason text, which is per-item prose (a specific page/URL
      // embedded in it) that would never actually group. The generalized
      // summary is what makes "22 different pages, same resolver defect"
      // collapse into one key instead of 22.
      const key = `${draft.action_type}::${summary}`;
      if (!clusters.has(key)) {
        clusters.set(key, { generatorId: draft.action_type, failureClass, summary, affectedIds: [] });
      }
      clusters.get(key).affectedIds.push(draft.id);
    }

    return [...clusters.values()]
      .filter((c) => c.affectedIds.length >= threshold)
      .map((c) => ({ ...c, affectedCount: c.affectedIds.length, status: 'detected' }));
  }

  return { detectCapabilityGaps };
}

export const capabilityGapDetector = createCapabilityGapDetector();
