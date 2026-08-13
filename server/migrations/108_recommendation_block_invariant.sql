-- The recommendation block invariant, made structural:
--
--   blocked_reason IS NOT NULL  =>  risk_tier = 'manual'
--
-- A blocked recommendation must never carry the 'safe' tier, because 'safe'
-- is precisely what the unattended shipping loop selects on
-- (agents/lib/auto-remediation.js) and what listOpenSafeRecommendations
-- hands to the execution engine. A row that is both is a contradiction that
-- sends known-unshippable work into the autonomous path, where it burns the
-- day's budget on rejections.
--
-- Site 1 accumulated 45 such rows. The writer was 078_execution_jobs.sql's
-- risk_tier backfill: a data statement in a directory where run.js re-applies
-- every file on every deploy, authored before blocked_reason existed, so each
-- deploy promoted open-but-blocked rows of certain types back to 'safe'. That
-- statement is now guarded; this migration repairs the damage it already did
-- and makes a future recurrence impossible to do silently.
--
-- The two halves must land together: with the CHECK in place but 078
-- unguarded, the next deploy would fail loudly on 078 instead of corrupting
-- data — better, but still a broken deploy.

-- 1. Converging repair. Written as a statement that is a no-op once the
--    invariant holds, so it is safe to re-run on every deploy like every
--    other file here.
UPDATE recommendations
   SET risk_tier = 'manual', updated_at = now()
 WHERE blocked_reason IS NOT NULL
   AND risk_tier <> 'manual';

-- 2. The invariant as a constraint. Drop-then-add is the only idempotent
--    form available (ADD CONSTRAINT has no IF NOT EXISTS), and matches how
--    100_recommendations_design_blocked.sql handles the same problem.
--
--    NOT VALID means existing rows are not re-scanned at ALTER time — the
--    UPDATE above has already converged them, and this keeps the migration
--    from taking a long lock on a large table. All future INSERTs and
--    UPDATEs are checked regardless; NOT VALID only skips the backfill scan.
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_blocked_is_manual;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_blocked_is_manual
  CHECK (blocked_reason IS NULL OR risk_tier = 'manual') NOT VALID;
