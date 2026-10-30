-- What the person chose to do with a keyword on the Keywords page: write a blog post, build a
-- landing page, or just track it (create nothing). NULL = no decision yet.
--
-- Additive and idempotent, like every file here; no data statements.

ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS content_plan TEXT;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_content_plan_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_content_plan_check
  CHECK (content_plan IS NULL OR content_plan IN ('blog', 'landing', 'track'));
