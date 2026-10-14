import { callLLMForJson } from '../../llm.js';
import { insertDecision } from '../../store/decisions.js';

// Phase 1 of the "one intelligence" consolidation plan (fix/system,
// 2026-09-22 planning conversation) — the single reasoning layer that sits
// between existing evidence producers (orchestrator.js's 30-agent findings,
// the Python data-analyst-agent's Investigation Engine, agent_fix_memory's
// past-outcome history) and the existing execution pipeline
// (recommendation-gates.js -> generator -> implementer -> PR). It decides
// WHAT to do and WHY; it never itself invokes a generator, touches git, or
// talks to GitHub — see decide() below for the one call this module makes
// downstream (insertDecision, a pure record).
//
// Deliberately NOT another orchestrator: it does not fan out to agents
// itself (orchestrator.js already owns that) and does not decide WHETHER a
// resulting action is currently shippable (recommendation-gates.js already
// owns that — eligibility is a downstream, separate question from "is this
// the right action"). This module's only job is the arbitration step that
// today doesn't exist anywhere: turning a bundle of evidence into ONE
// action decision with a stated rationale and stated alternatives rejected.
//
// UNWIRED as of this commit — no cron job, generator, or route calls
// decide() yet. That wiring is a later phase (Phase 4 for the keyword-gap
// ship cycle specifically, Phase 7 more broadly), each behind its own
// feature flag per the plan's rollout section, so this module can be
// reviewed and tested in isolation first.

export const DECISION_ACTIONS = Object.freeze([
  'improve_page', 'new_page', 'fix_technical', 'fix_metadata',
  'internal_linking', 'investigate_further', 'do_nothing',
]);

// Below this many independent evidence items, a real decision would be
// reasoning ahead of what's actually known — the plan's explicit
// requirement (§2, §3: "when evidence is insufficient, the system must
// recognize that... and gather more evidence or defer the decision") is
// enforced here as a cheap, deterministic gate BEFORE any LLM call, not as
// something the model is merely asked to self-police. Mirrors
// analyst-fusion.js's MIN_CORROBORATION_TO_ACT shape (a evidence-count
// floor before acting) rather than inventing a new threshold concept.
export const MIN_EVIDENCE_TO_DECIDE = 1;

// Below this confidence, real contradicting evidence (from the model's own
// self-critique, not a second pass) is enough to override the model's
// chosen action to 'investigate_further' — a cheap, deterministic gate
// applied in code, same discipline MIN_EVIDENCE_TO_DECIDE already uses,
// rather than trusting the model to police its own overconfidence. A HIGH-
// confidence decision with contradicting evidence is left as-is: the model
// already weighed that evidence and still judged it not decisive — second-
// guessing a confident call here would make self-critique indistinguishable
// from just lowering every decision's effective confidence.
export const SELF_CRITIQUE_DOWNGRADE_CONFIDENCE = 0.5;

const SYSTEM_PROMPT = `You are the decision-making layer of a website growth-intelligence system. You are given a situation and a bundle of real evidence gathered from multiple sources (SEO agents, analytics investigations, past outcomes). Your job is ONLY to decide what should happen next — you never write content, never invent facts, and never invent numbers not present in the evidence given.

Answer these questions, grounded ONLY in the evidence provided:
1. What is actually happening (the situation, restated precisely)?
2. What evidence supports this?
3. What is the likely root cause, if the evidence supports one? If it doesn't, say so — do not guess.
4. What additional evidence would help, if any is missing?
5. What is the single best action?
6. Why this action, specifically?
7. Why not the realistic alternatives?
8. Should the system act now, investigate further, or do nothing?
9. What should execute the action (which capability/generator), if action requires one?
10. How should success be validated later?

Before finalizing, critique your own decision honestly:
11. Which of the evidence items given, if any, actually argue AGAINST the action you chose (not just items that are silent on it)?
12. Is there a plausible alternative explanation for the situation that would call for a different action?
13. What single fact, if it turned out to be false, would make this decision wrong?
14. What is the smallest, safest action that would test this hypothesis before committing to the full action?

The action MUST be exactly one of: improve_page, new_page, fix_technical, fix_metadata, internal_linking, investigate_further, do_nothing.

Use 'investigate_further' when the evidence is real but insufficient to justify a concrete change. Use 'do_nothing' when the evidence shows there is genuinely no worthwhile action. Do NOT default to 'new_page' just because a keyword or topic was found — check whether the evidence already shows a relevant existing page; if so, prefer 'improve_page' or 'internal_linking' instead.

Respond with ONLY a JSON object of this exact shape, no markdown, no prose outside the JSON:
{
  "situation": string,
  "rootCause": { "hypothesis": string, "confidence": number, "supportingEvidence": string[] } | null,
  "missingEvidence": string[],
  "action": one of the allowed actions above,
  "actionTarget": { "generatorId": string | null, "pageUrl": string | null } | null,
  "rationale": string,
  "alternativesConsidered": [ { "action": string, "whyRejected": string } ],
  "confidence": number between 0 and 1,
  "validationPlan": string,
  "selfCritique": {
    "contradictingEvidence": string[],
    "alternativeExplanation": string | null,
    "wouldBeWrongIf": string,
    "smallestSafeTest": string | null
  }
}`;

function isValidDecisionShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!DECISION_ACTIONS.includes(parsed.action)) return false;
  if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) return false;
  if (!Array.isArray(parsed.missingEvidence)) return false;
  if (!Array.isArray(parsed.alternativesConsidered)) return false;
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) return false;
  const sc = parsed.selfCritique;
  if (!sc || typeof sc !== 'object') return false;
  if (!Array.isArray(sc.contradictingEvidence)) return false;
  if (typeof sc.wouldBeWrongIf !== 'string' || !sc.wouldBeWrongIf.trim()) return false;
  return true;
}

// Dependency-injection factory (same shape as recommendation-gates.js's
// createRecommendationGates) so decide() is testable without a real DB or a
// real LLM call — tests pass a stub callLLMForJsonFn/insertDecisionFn.
export function createDecisionEngine({
  callLLMForJsonFn = callLLMForJson,
  insertDecisionFn = insertDecision,
} = {}) {
  // `evidence` is Evidence[] — [{source, summary, ref}], already gathered by
  // the caller (orchestrator.js findings, Investigation Engine records,
  // agent_fix_memory lookups, etc.). This function does not gather evidence
  // itself in Phase 1 — that correlation step is Phase 2's
  // gatherCorrelatedEvidence, layered on top of this once it exists.
  async function decide(siteId, situation, evidence = []) {
    if (!Array.isArray(evidence) || evidence.length < MIN_EVIDENCE_TO_DECIDE) {
      return insertDecisionFn(siteId, {
        situation,
        evidence,
        rootCause: null,
        missingEvidence: ['No corroborating evidence was gathered for this situation yet.'],
        action: 'investigate_further',
        actionTarget: null,
        rationale: 'Insufficient evidence to decide — deferring rather than guessing.',
        alternativesConsidered: [],
        confidence: 0,
        validationPlan: null,
        selfCritique: {
          contradictingEvidence: [],
          alternativeExplanation: null,
          wouldBeWrongIf: 'More evidence arrives and it turns out to support a concrete action after all.',
          smallestSafeTest: null,
        },
      });
    }

    const user = `Situation: ${situation}\n\nEvidence:\n${JSON.stringify(evidence)}`;
    const parsed = await callLLMForJsonFn(SYSTEM_PROMPT, user, {
      maxTokens: 900,
      tier: 'monthly', // a decision is a higher-stakes, lower-frequency call than a per-page daily narrative — same tier choice as competitor discovery in llm.js
      validate: isValidDecisionShape,
    });

    // Deterministic downgrade, not left to the model to self-police (same
    // discipline as the MIN_EVIDENCE_TO_DECIDE gate above): the model's own
    // self-critique named real evidence against its own chosen action, and
    // it wasn't confident enough for that to be a considered, overridden
    // objection. 'investigate_further' and 'do_nothing' need no downgrade —
    // there is no more-cautious action to fall back to.
    const hasContradiction = parsed.selfCritique.contradictingEvidence.length > 0;
    const lowConfidence = parsed.confidence < SELF_CRITIQUE_DOWNGRADE_CONFIDENCE;
    const downgrade = hasContradiction && lowConfidence
      && parsed.action !== 'investigate_further' && parsed.action !== 'do_nothing';

    return insertDecisionFn(siteId, {
      situation: parsed.situation || situation,
      evidence,
      rootCause: parsed.rootCause ?? null,
      missingEvidence: parsed.missingEvidence || [],
      action: downgrade ? 'investigate_further' : parsed.action,
      actionTarget: downgrade ? null : (parsed.actionTarget ?? null),
      rationale: downgrade
        ? `Self-critique found unresolved contradicting evidence at low confidence (${parsed.confidence}) for the originally chosen action ("${parsed.action}"): ${parsed.rationale}`
        : parsed.rationale,
      alternativesConsidered: parsed.alternativesConsidered || [],
      confidence: parsed.confidence,
      validationPlan: parsed.validationPlan || null,
      selfCritique: parsed.selfCritique,
    });
  }

  return { decide };
}

// Default instance for real callers (once a later phase wires one in) —
// tests use createDecisionEngine(stubs) directly instead.
export const decisionEngine = createDecisionEngine();
