-- Keyword-gap coverage verdicts (server/agents/lib/keyword-coverage.js).
--
-- existing_page_match (113) could only say "a page covers it" or NULL, and NULL
-- meant both "checked, nothing found" and "never checked" — so every unmatched
-- gap re-fetched pages and re-asked an LLM every week, and a keyword that
-- differs from a page only by language, country or intent was indistinguishable
-- from a true duplicate.
--
-- coverage_status separates SAME TOPIC from SAME SEO TARGET:
--   duplicate | covered | opportunity | market_gap | language_gap | intent_gap | uncertain
-- coverage_checked_at is the cache key (a checked "no match" is now a real,
-- cacheable answer); coverage_evidence keeps the signals and the signature of
-- the evidence, so an unchanged relationship never triggers new analysis.
-- language_code is the keyword's own language (location_code, 159, is its market).
--
-- Schema only, all additive and idempotent (this directory re-runs every file on
-- every deploy). Existing rows keep NULL until the backfill script classifies them.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_status TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_reason TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_checked_at TIMESTAMPTZ;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS coverage_evidence JSONB;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS language_code TEXT;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_coverage_status_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_coverage_status_check
  CHECK (coverage_status IS NULL OR coverage_status IN
    ('duplicate', 'covered', 'opportunity', 'market_gap', 'language_gap', 'intent_gap', 'uncertain'));
