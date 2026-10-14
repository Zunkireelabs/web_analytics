-- Item 6 of the "one intelligence" consolidation plan's general-reasoning
-- pass: self-critique, built into decision-engine.js's own reasoning call
-- rather than a separate critic agent. Stores the model's own answer to
-- "what evidence contradicts this, what alternative explains it, what would
-- make it wrong, what's the smallest safe test" alongside the decision it
-- critiques, so a later reviewer (human or another decision) can see the
-- objections that were considered and weighed, not just the final verdict.
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS self_critique JSONB;

COMMENT ON COLUMN decisions.self_critique IS
  '{contradictingEvidence: string[], alternativeExplanation: string|null, wouldBeWrongIf: string, smallestSafeTest: string|null} — the same call''s own critique of its chosen action, used to deterministically downgrade to investigate_further when contradicting evidence coincides with low confidence (see decision-engine.js SELF_CRITIQUE_DOWNGRADE_CONFIDENCE).';
