import { listDrafts } from '../../store/drafts.js';
import { classifyAbandonReason, RETRY_POLICY } from '../../lib/attempt-classification.js';
import { decisionEngine } from './decision-engine.js';

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

// classifyAbandonReason's own literal fallback text (attempt-classification.js)
// for a reason matching none of its RULES — "An unrecognized reason is
// ITEM_DEFECT... surfaces as a capped item rather than retrying forever in
// silence" per that module's comment. Every genuinely NOVEL failure pattern
// collapses to this exact same summary, which is the real blind spot a
// fixed taxonomy has: two unrelated novel failure modes on the same
// generator would cluster together here with no way to tell them apart
// from the classification alone. investigateUnclassified below exists
// specifically to not just trust this bucket at face value.
export const UNCLASSIFIED_FALLBACK_SUMMARY = 'This fix could not be applied automatically.';

// Collapses the per-item-specific parts of a raw abandoned_reason (a file
// path, a page slug, a number) so distinct raw strings that are really the
// SAME underlying error shape group together. Deliberately crude/regex-based
// rather than embedding-based, same "keep matching decisions inspectable"
// convention agent-memory.js's own header comment states for this codebase.
function normalizeReasonShape(reason) {
  return (reason || '')
    .replace(/[\w.-]*\/[\w./-]+/g, '<path>') // file paths / URLs
    .replace(/\d+/g, '#')                     // numbers (ids, counts)
    .trim();
}

export const CLUSTER_THRESHOLD = 3;

// How many DISTINCT normalized failure shapes to send as evidence per
// investigation. Bounded for prompt cost, same reasoning as
// findRelevantMemory's own `limit` — but critically this is a cap on
// DISTINCT SHAPES after frequency-sorting, not a cap on the most recent N
// raw items. A most-recent-N cap was tried first and produced a materially
// wrong conclusion on real data (Admizz site 8862, 2026-09-22): the 20 most
// recently abandoned drafts happened to be 18 no-jsx-return-found / 2
// self-closing-root-no-body, the INVERSE of the true 18/98 split across all
// 116 — decision-engine's investigation named the minority pattern as
// primary. Frequency-sorted distinct shapes fixes this: both real
// sub-causes are guaranteed to appear, each with its own true count.
const MAX_EVIDENCE_SHAPES = 20;

// How far back to scan per detection pass. Bounded rather than "all
// history" for the same reason listDraftsForBoard caps 'implemented' rows
// (store/drafts.js) — abandoned-draft history for an active site grows
// without bound, and a capability gap worth repairing is a RECENT, still-
// recurring pattern, not something first seen a year ago.
export const LOOKBACK_LIMIT = 200;

// Real production incident (2026-09-22, Admizz Education, site 8862, queried
// read-only): 116 abandoned expand-content drafts, none matching any
// existing attempt-classification.js RULE, all sharing the generic fallback
// summary — two genuinely distinct root causes underneath it
// (self-closing-root-no-body: 98, no-jsx-return-found: 18, both under the
// SEOAI:EXPANDEDCONTENT marker), unresolved and still recurring as of that
// query. Confirmed exactly the blind spot UNCLASSIFIED_FALLBACK_SUMMARY
// above describes: this codebase's closed-set classifier cannot, on its
// own, tell "two related root causes on one generator" apart from "22
// unrelated novel failures that all happen to be unrecognized". Investigated
// with decision-engine below rather than trusted as one bucket.

// `deps` is injectable (same createX(deps) shape as every other module this
// plan added) for unit testing without a real DB or a real LLM call.
export function createCapabilityGapDetector({
  listDraftsFn = listDrafts,
  classifyAbandonReasonFn = classifyAbandonReason,
  decisionEngineFn = decisionEngine,
} = {}) {
  async function detectCapabilityGaps(siteId, { threshold = CLUSTER_THRESHOLD, investigateUnclassified = true } = {}) {
    const abandoned = await listDraftsFn(siteId, { status: 'abandoned', limit: LOOKBACK_LIMIT });
    const clusters = new Map();

    for (const draft of abandoned) {
      const { failureClass, retryPolicy, summary } = classifyAbandonReasonFn(draft.abandoned_reason);
      if (retryPolicy !== RETRY_POLICY.ITEM_DEFECT) continue;

      // Clustered by (generator, generalized failure summary) — NOT by raw
      // abandoned_reason text, which is per-item prose (a specific page/URL
      // embedded in it) that would never actually group. The generalized
      // summary is what makes "many different pages, same resolver defect"
      // collapse into one key instead of many.
      const key = `${draft.action_type}::${summary}`;
      if (!clusters.has(key)) {
        clusters.set(key, { generatorId: draft.action_type, failureClass, summary, affectedIds: [], rawReasons: [] });
      }
      const cluster = clusters.get(key);
      cluster.affectedIds.push(draft.id);
      // Raw text kept ONLY for clusters that might need investigation below
      // (the generic bucket) — a known RULES match never needs it, so
      // capping this list is not a concern for the common case.
      if (summary === UNCLASSIFIED_FALLBACK_SUMMARY) cluster.rawReasons.push(draft.abandoned_reason);
    }

    const gaps = [...clusters.values()]
      .filter((c) => c.affectedIds.length >= threshold)
      .map((c) => ({ ...c, affectedCount: c.affectedIds.length, status: 'detected' }));

    if (!investigateUnclassified) return gaps;

    // Only the generic-fallback clusters get investigated — a cluster that
    // already matched a real RULES entry has a real, specific summary and
    // needs no LLM call to explain what it is. This is the ONLY LLM call
    // this module makes, and only for the shape the closed-set classifier
    // structurally cannot resolve on its own.
    for (const gap of gaps) {
      if (gap.summary !== UNCLASSIFIED_FALLBACK_SUMMARY) continue;
      const situation = `${gap.affectedCount} drafts for generator "${gap.generatorId}" on site ${siteId} were ` +
        `abandoned with a failure reason that matches no known classification rule. Determine whether these share ` +
        `one root cause (and if so what capability is broken or missing and whether it should be repaired/extended), ` +
        `or whether they are actually several distinct, unrelated problems that were only grouped together because ` +
        `the existing classifier could not tell them apart.`;
      // Group by normalized shape and sort by TRUE frequency across the
      // whole cluster, not by recency — see MAX_EVIDENCE_SHAPES' comment
      // for why a recency-based sample produced a wrong conclusion on real
      // data. Each evidence item states its real count, so decision-engine
      // reasons from the actual distribution rather than one example.
      const shapeGroups = new Map();
      for (const reason of gap.rawReasons) {
        const shape = normalizeReasonShape(reason);
        if (!shapeGroups.has(shape)) shapeGroups.set(shape, { example: reason, count: 0 });
        shapeGroups.get(shape).count += 1;
      }
      const evidence = [...shapeGroups.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, MAX_EVIDENCE_SHAPES)
        .map(([shape, { example, count }], i) => ({
          source: 'abandoned-draft-reason',
          summary: `Occurred ${count} time(s) across this cluster: ${example}`,
          ref: `raw-reason-shape:${i}`,
          meta: { count, normalizedShape: shape },
        }));
      try {
        gap.investigation = await decisionEngineFn.decide(siteId, situation, evidence);
      } catch (err) {
        console.warn(`[capability-gap-detector] investigation failed for ${gap.generatorId}: ${err.message}`);
        gap.investigation = null;
      }
    }

    return gaps;
  }

  return { detectCapabilityGaps };
}

export const capabilityGapDetector = createCapabilityGapDetector();
