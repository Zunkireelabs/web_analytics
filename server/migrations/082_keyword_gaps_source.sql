-- Tags each keyword_gaps row with where it came from. Step 3's own
-- clustering-based gap analysis (agents/clustering.py) doesn't set this
-- column, so it defaults to 'internal_analysis' with no change to its own
-- INSERT. Step 4's external keyword research (same script, run after Step
-- 3) explicitly writes 'claude_research', so the two are distinguishable.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'internal_analysis';

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_source_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_source_check
  CHECK (source IN ('internal_analysis', 'claude_research'));
