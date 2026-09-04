-- Adds the 'infra' outcome, and RELABELS the history that is already poisoned
-- with it, because the writer fix alone would not have unblocked anything for
-- weeks.
--
-- The bug: generator-learning.js scored every 'failed' row as the generator's
-- own fault. store/drafts.js's convergence cap had always known better and
-- excluded transient/infrastructural/human causes from its own count, but
-- the two never shared that knowledge, so the scorer punished generators for
-- GitHub rate limits, shared batch-PR failures, a citation provider running
-- out of quota, a missing PAT, and humans closing or returning drafts.
--
-- Measured on site 1 the day this was written (2026-09-04): of 42 failures
-- inside the live 30-row scoring window, THREE were genuine generator faults.
-- The other 39 had demoted seven generators — expand-content (320 open
-- recommendations), broken-link-fix (30), qa-content (22), schema-repair (12),
-- alt-text (10), analytics-install (2), duplicate-id-fix (1) — removing 398
-- of 569 open recommendations, 70% of the backlog, from the autonomous
-- shipping loop. The daily budget was spending 5 of its 60 slots while
-- hundreds of shippable items sat behind a demotion none of them earned.
--
-- Why a relabel and not just the writer fix: getLearnedConfidenceMap scores a
-- trailing window of the last 30 rows PER GENERATOR. A demoted generator
-- ships nothing, so it records no new rows, so its window never turns over —
-- the demotion is self-sustaining and would have outlived the fix
-- indefinitely. The history has to be corrected for the fix to take effect.
--
-- SOURCE OF TRUTH: server/lib/attempt-classification.js. The predicates below
-- mirror its RULES for the causes actually present in this table; that module
-- decides attribution for all NEW rows (via generator-learning.js's
-- attributeOutcome). This statement is a one-time historical correction, not
-- a second classifier to keep in sync — nothing reads it after it runs.
-- Deliberately conservative: anything it does not positively recognise stays
-- 'failed', matching attributeOutcome's own "unexplained failures are real
-- until proven otherwise" stance.

ALTER TABLE generator_outcomes DROP CONSTRAINT IF EXISTS generator_outcomes_outcome_check;

ALTER TABLE generator_outcomes ADD CONSTRAINT generator_outcomes_outcome_check
  CHECK (outcome IN ('shipped', 'failed', 'refused', 'merged', 'rejected', 'infra',
                     'impact-positive', 'impact-negative', 'impact-neutral'));

-- Idempotent by construction: it only ever moves 'failed' -> 'infra', and a
-- row already moved no longer matches the outcome filter on a re-run.
-- 'rejected' is included alongside 'failed' for one specific reason: the
-- reconciler writes the sentinel 'sent_back_to_recommendations' through that
-- outcome, and it means only "withdrawn and returned to the board". A human's
-- ACTUAL reject reason is free text, matches none of the predicates below,
-- and correctly stays 'rejected'.
UPDATE generator_outcomes
   SET outcome = 'infra'
 WHERE outcome IN ('failed', 'rejected')
   AND detail IS NOT NULL
   AND (
     -- Human decisions. The draft was fine; the decision was elsewhere.
     detail IN ('pr_closed_without_merge', 'superseded', 'sent_back_to_recommendations')
     -- GitHub API rate limiting — transient by definition, and the single
     -- largest abandon cause in the live table.
     OR detail ILIKE '%rate limit%'
     -- The batch's ONE shared push/PR failed, which fails every pending item
     -- at once regardless of content (54 drafts in a single call on
     -- 2026-09-01). Its text is sanitized, so it does not match the
     -- rate-limit predicate above even when a rate limit was the real cause.
     OR detail LIKE 'Batch push/PR failed%'
     OR detail ILIKE '%could not be opened right now%'
     -- Date-keyed batch branch diverged from the default branch. Self-healing:
     -- tomorrow's branch forks fresh.
     OR (detail ILIKE '%batch branch%' AND detail ILIKE '%diverged%')
     -- Draft-lifecycle bookkeeping, never a verdict on generated content.
     OR detail LIKE 'Stuck at "%'
     OR detail LIKE 'Recovered:%'
     OR detail ILIKE '%not in a submittable state%'
     -- The citation-grounding provider was down or out of quota. This one
     -- cause alone accounts for most of expand-content's 15 "failures", and
     -- so for 320 of the 398 blocked recommendations.
     OR detail ILIKE '%citation search is temporarily unavailable%'
     OR detail ILIKE '%daily query cap reached%'
     OR detail ILIKE '%refusing further citation search%'
     -- Config gaps: waiting on a value a human supplies, never "unfixable".
     -- The item must become eligible again the moment the config lands.
     OR detail ILIKE '%No url_file_map entry matches%'
     OR detail ILIKE '%No markers configured for%'
     OR detail ILIKE '%No GitHub PAT set%'
     OR detail ILIKE '%bad credentials%'
     -- A design-review gate REMOVED by commit 8a32037. Nothing produces this
     -- any more, but rows from before the removal still sit in the window.
     OR detail ILIKE '%design has not been reviewed%'
     -- Another draft already fixed the underlying issue — nothing left to do,
     -- and not a failure of this item at all.
     OR detail ILIKE '%nothing left to publish%'
   );
