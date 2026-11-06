-- Competitor classification (Phase 2): tells apart the three things that all look alike in a SERP tally today.
--
--   business         - sells the same kind of thing in the same market: a genuine rival, and the only kind whose
--                      keyword footprint should ever drive content work for this project.
--   organic          - competes for the searches but is not a rival: a directory, marketplace, publisher or news site.
--                      Useful as topic evidence, never as "your competitor".
--   keyword_specific - showed up for one or two queries only. Evidence about those keywords, not a competitor.
--
-- `kind` is NULL on every pre-existing row and stays NULL until a classified run overwrites it, so nothing here
-- reinterprets rows written before this migration. `excluded_reason` (migration 133) keeps its meaning: a platform
-- domain is still excluded, independently of kind.
--
-- `classification` holds the evidence the decision was made from (SERP hits, service-term overlap, location match,
-- what the signals were) so a label can always be explained and re-judged later. No invented metrics: a signal that
-- could not be measured is absent, not zero.
--
-- `first_seen_at` is when this project first saw the domain at all. `discovered_at` already carries the row's creation
-- time, but an upsert never rewrites it, so the two agree; first_seen_at exists to be read by emergence detection
-- without depending on that invariant.
--
-- Additive and idempotent, like every file here; no data statements.
ALTER TABLE competitor_profiles ADD COLUMN IF NOT EXISTS kind            TEXT;
ALTER TABLE competitor_profiles ADD COLUMN IF NOT EXISTS relevance_score NUMERIC(4,3);
ALTER TABLE competitor_profiles ADD COLUMN IF NOT EXISTS classification  JSONB;
ALTER TABLE competitor_profiles ADD COLUMN IF NOT EXISTS first_seen_at   TIMESTAMPTZ;
ALTER TABLE competitor_profiles ADD COLUMN IF NOT EXISTS emerging        BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE competitor_profiles DROP CONSTRAINT IF EXISTS competitor_profiles_kind_check;
ALTER TABLE competitor_profiles ADD CONSTRAINT competitor_profiles_kind_check
  CHECK (kind IS NULL OR kind IN ('business', 'organic', 'keyword_specific'));

ALTER TABLE competitor_profiles DROP CONSTRAINT IF EXISTS competitor_profiles_relevance_score_check;
ALTER TABLE competitor_profiles ADD CONSTRAINT competitor_profiles_relevance_score_check
  CHECK (relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1));

-- The lookup Phase 3 needs: this project's business competitors, strongest evidence first.
CREATE INDEX IF NOT EXISTS competitor_profiles_kind_idx
  ON competitor_profiles (site_id, kind, relevance_score DESC);
