-- Phase 6: marks a verified opportunity whose outcome has already been counted towards what this project has learned.
--
-- Without this flag the reconcile pass would count the same verified outcome on every run, and the scorer's learned
-- multiplier would be taught from one event repeated — a system convincing itself of something that happened once.
-- Defaults to false, so every existing row is correctly "not yet counted".
--
-- Additive and idempotent, like every file here; no data statements.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS outcome_counted BOOLEAN NOT NULL DEFAULT false;

-- The reconcile pass's own lookup: this project's verified-but-uncounted opportunities.
CREATE INDEX IF NOT EXISTS keyword_gaps_outcome_pending_idx
  ON keyword_gaps (site_id, lifecycle_state) WHERE outcome_counted = false;
