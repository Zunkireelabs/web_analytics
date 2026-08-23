-- Extends generator_outcomes (migration 114) with three new outcome values
-- so fix-impact.js's measured GSC delta can be logged into the SAME
-- existing outcome/confidence mechanism generator-learning.js already
-- reads, as a signal DISTINCT from the technical shipped/failed/merged/
-- rejected values already there — never merged into the same ratio, since
-- "did it ship" and "did it move the metric" are different questions (see
-- generator-learning.js's getLearnedConfidenceMap, which now aggregates
-- these into a separate impactConfidence bucket per generator).
--
-- 'impact-positive' — fix-impact.js measured a real post-merge improvement
-- 'impact-negative' — fix-impact.js measured a real post-merge decline
-- 'impact-neutral'  — fix-impact.js measured no material change; recorded
--                      for the audit trail but excluded from the ratio,
--                      same treatment 'refused' already gets for the
--                      technical signal (a neutral result says nothing
--                      about whether the generator's impact is trustworthy)
--
-- 'insufficient-data' measurements are deliberately never recorded here at
-- all (see fix-impact.js) — no row is the correct way to represent "we
-- don't know", never a fabricated neutral/negative signal.

ALTER TABLE generator_outcomes DROP CONSTRAINT IF EXISTS generator_outcomes_outcome_check;

ALTER TABLE generator_outcomes ADD CONSTRAINT generator_outcomes_outcome_check
  CHECK (outcome IN ('shipped', 'failed', 'refused', 'merged', 'rejected', 'impact-positive', 'impact-negative', 'impact-neutral'));
