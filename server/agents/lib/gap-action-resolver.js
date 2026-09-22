import { gapDraftEligibility } from './analyst-seo-mapping.js';
import { decisionEngine } from './decision-engine.js';
import { evidenceGatherer } from './decision-evidence.js';

// Phase 4 of the "one intelligence" consolidation plan (fix/system) —
// narrow scope, per explicit direction: gapDraftEligibility() (analyst-
// seo-mapping.js) is already a correct, deterministic keyword -> action
// arbitrator and stays the source of truth for every case it can
// confidently resolve. This module does NOT re-decide those cases. It only
// engages decision-engine for the two shapes gapDraftEligibility itself
// already flags as unresolved:
//
//   1. requiresFutureInfrastructure: true — a comparison-shaped topic with
//      no generator able to draft it (see gapDraftEligibility's own
//      comment: "a genuine comparison-page opportunity the system found
//      and could not act on yet").
//   2. generatorId === 'landing-page' — riskTierForGenerator keeps this
//      MANUAL regardless of what happens here (a human always reviews it;
//      this module does not and must not change that), but it is exactly
//      the kind of high-commercial-value, low-confidence case cross-domain
//      evidence can usefully inform before a human looks at it.
//
// Every other eligibility result (null / blog-outline / faq, i.e. the
// clear majority of gaps) passes straight through with source:
// 'deterministic' and NO decision-engine call — this module adds no cost
// to the cases already working correctly.
//
// Purely additive and UNWIRED: nothing in qualifyAndShipContentGaps calls
// this yet. It returns a decision for a caller to use; it does not itself
// change any recommendation's risk tier, block state, or shipping
// eligibility. Wiring resolveGapAction into the real ship cycle is a
// deliberate later step, gated on review, not something this module does
// on its own.
export const AMBIGUOUS_KINDS = Object.freeze(['requires-future-infrastructure', 'manual-landing-page']);

function classifyAmbiguity(eligibility) {
  if (!eligibility) return null; // confidently resolved to "do nothing" — not ambiguous
  if (eligibility.requiresFutureInfrastructure === true) return 'requires-future-infrastructure';
  if (eligibility.generatorId === 'landing-page') return 'manual-landing-page';
  return null; // blog-outline / faq — gapDraftEligibility already resolved this confidently
}

function describeSituation(gap, ambiguityKind) {
  const base = `Keyword gap "${gap.topic}" (search intent: ${gap.search_intent || 'unknown'}, ` +
    `product relevance: ${gap.product_relevance || 'unknown'}, existing page match: ${gap.existing_page_match || 'none'}).`;
  if (ambiguityKind === 'requires-future-infrastructure') {
    return `${base} The existing keyword-gap eligibility rules classified this as a comparison-shaped topic with ` +
      `no generator currently able to draft it — no page can be created or improved for it today without new ` +
      `infrastructure. Decide whether this is still worth investigating further (e.g. as a future infrastructure ` +
      `priority) or should be dropped.`;
  }
  return `${base} The existing keyword-gap eligibility rules classified this as commercial-intent, directly ` +
    `product-relevant content routed to a landing page, which always requires human approval before shipping ` +
    `regardless of this decision. Decide whether the evidence actually supports creating a new page, or whether ` +
    `improving an existing page / internal linking would serve this opportunity better before a human reviews it.`;
}

// `deps` is injectable (same shape as decision-engine.js/decision-evidence.js)
// for unit testing without a real DB, LLM, or Data Analyst call.
export function createGapActionResolver({
  gapDraftEligibilityFn = gapDraftEligibility,
  decisionEngineFn = decisionEngine,
  gatherEvidenceFn = evidenceGatherer.gatherCorrelatedEvidence,
} = {}) {
  async function resolveGapAction(gap, siteId) {
    const eligibility = gapDraftEligibilityFn(gap);
    const ambiguityKind = classifyAmbiguity(eligibility);

    if (!ambiguityKind) {
      // Confidently resolved by the existing deterministic rules — kept
      // as-is, no decision-engine call, no cost added to the common case.
      return { source: 'deterministic', ambiguityKind: null, eligibility, decision: null };
    }

    const evidence = await gatherEvidenceFn('keyword_opportunity', siteId, { symptoms: gap.topic });
    const decision = await decisionEngineFn.decide(siteId, describeSituation(gap, ambiguityKind), evidence);

    return { source: 'decision-engine', ambiguityKind, eligibility, decision };
  }

  return { resolveGapAction };
}

export const gapActionResolver = createGapActionResolver();
