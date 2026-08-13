-- Adds 'user_request' to keyword_gaps.source. Until now the column's CHECK
-- (migration 082) only admitted the two machine-generated passes:
-- 'internal_analysis' (clustering-based gap analysis) and 'claude_research'
-- (external keyword research). The Analyst page now lets a human type a
-- keyword they want to grow for, which enters the exact same review →
-- approve → Action Center pipeline as a machine-found gap, so it needs its
-- own source value rather than masquerading as one of those two.
ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_source_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_source_check
  CHECK (source IN ('internal_analysis', 'claude_research', 'user_request'));
