-- Adds 'recovered' to recommendation_attempts.outcome: a distinct event from
-- 'failed'/'returned' recording that the system re-analyzed a finding against
-- LIVE content and refreshed its recommendation's params, rather than merely
-- retrying the same generator against the same stale evidence again.
--
-- Why this needs its own outcome instead of reusing 'returned' (already used
-- by the reconciler's stall reclaim for "sent back for another attempt"):
-- 'returned' says nothing tried yet was wrong with the item, so it must never
-- count toward anything. 'recovered' is the opposite kind of fact — the
-- system concluded the ITEM_DEFECT retries so far were failing against STALE
-- evidence, took an active step to fix that (re-detected the finding, pulled
-- fresh params), and is now trying again on new grounds. Distinguishing the
-- two is what lets the reconciler tell "we've retried the identical approach
-- N times" (ship-pacing's existing MAX_FAILED_ATTEMPTS, unmoved) apart from
-- "we've exhausted N independent, freshly-evidenced attempts" (the new
-- MAX_RECOVERY_CYCLES, lib/action-center-reconciler.js) — the latter is what
-- decides whether autonomous recovery is retried again or, only once genuinely
-- exhausted, handed to a human as the last resort instead of the default.
--
-- This is now the sole owner of recommendation_attempts_outcome_check
-- (previously defined inline in 139's CREATE TABLE) — any future outcome
-- value must extend the CHECK list here, not add a new DROP/ADD elsewhere,
-- per the convention 039 established for drafts_status_check.
ALTER TABLE recommendation_attempts DROP CONSTRAINT IF EXISTS recommendation_attempts_outcome_check;
ALTER TABLE recommendation_attempts ADD CONSTRAINT recommendation_attempts_outcome_check
  CHECK (outcome IN ('shipped', 'failed', 'returned', 'superseded', 'recovered'));
