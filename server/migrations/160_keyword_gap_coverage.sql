-- Outcome of the keyword existing-page coverage check (agents/lib/keyword-coverage.js),
-- recorded per gap so the Analyst keyword list can hide keywords an existing
-- page already covers without re-running page fetches / an LLM on every load.
--
-- coverage_checked_at IS NULL means "never judged" (also: judged but the LLM
-- or page fetch was unavailable, which deliberately records nothing so the
-- check retries). coverage_decision is covered | partially_covered |
-- not_covered; only 'covered' ever hides a keyword. existing_page_match (081)
-- is still set ONLY for 'covered', so its meaning for approval is unchanged.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_checked_at TIMESTAMPTZ;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_decision TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_detail JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_coverage_decision_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_coverage_decision_check
  CHECK (coverage_decision IS NULL OR coverage_decision IN ('covered', 'partially_covered', 'not_covered'));
