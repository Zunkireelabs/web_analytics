-- Cleanup for databases that ran migration 100 while it still created a column
-- called `design_blocked_reason` (that file now creates `blocked_reason`
-- directly — see its comment for why the rename could not live here instead).
--
-- Carries any real values across, then DROPS the old column. Dropping is what
-- makes this converge: this directory has no migration-tracking table, so every
-- file re-runs on every `npm run migrate`. A rename would be undone on the next
-- run by whatever earlier file created the old name; a drop stays dropped,
-- because nothing creates it any more.
--
-- The COALESCE direction matters: `blocked_reason` wins where both are set. On
-- a database that already ran the corrected 100, `blocked_reason` holds the
-- live value and the old column is a stale leftover — copying the old one over
-- it would resurrect a block that may already have cleared.
--
-- No-op on a fresh database, where the old column never existed at all.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recommendations' AND column_name = 'design_blocked_reason'
  ) THEN
    UPDATE recommendations
       SET blocked_reason = COALESCE(blocked_reason, design_blocked_reason)
     WHERE design_blocked_reason IS NOT NULL;

    ALTER TABLE recommendations DROP COLUMN design_blocked_reason;
  END IF;
END $$;

-- The old partial index is dropped along with its column, but an installation
-- that somehow has the index without the column would otherwise keep it
-- forever. Explicit, and harmless when it is already gone.
DROP INDEX IF EXISTS recommendations_design_blocked_idx;
