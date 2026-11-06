-- Competitor opportunities (Phase 4): competitor evidence enters the EXISTING keyword_gaps queue rather than a new one.
--
-- The deliberate choice here is to add to keyword_gaps instead of creating a parallel table. That queue already has
-- everything an opportunity needs to be shipped safely and already feeds the weekly ship cycle
-- (qualifyAndShipContentGaps -> generators -> recommendation gates -> draft -> PR -> human merge): observation_count,
-- search_intent, product_relevance, existing_page_match, coverage_status, content_plan, topic_cluster. A second queue
-- would mean a second qualification path, a second set of gates, and two places for the same topic to be shipped from.
--
--   source 'competitor_footprint'  - this gap came from a rival's measured footprint, not from an LLM topic sweep.
--   opportunity_type               - WHAT TO DO, decided from evidence, not left for a generator to guess:
--       missing          a business rival ranks top-10, we have no ranking and no page for it
--       position_gap     we rank, but far behind the best rival on the same keyword
--       topic_gap        several rivals are strong on one cluster and we have no coverage at all
--       service_location a service we sell x a place we target, that rivals rank for and we do not
--       improve_page     an existing page of ours already targets this: improve it, never create a second one
--       new_page         nothing of ours matches and nothing would be cannibalised
--   competitor_evidence - which rivals, at which positions, with which measured demand, and when it was captured.
--                         Enough to explain any opportunity without re-querying the provider.
--   opportunity_score   - the ordering only (0..1). Never a business promise, and never search volume alone.
--   lifecycle_state     - discovered -> drafted -> merged -> deployed -> verified. Learning reads 'verified' only, so
--                         an opened PR can never be counted as a result.
--
-- Every column is nullable or defaulted, so rows written before this migration keep their current meaning.
-- Additive and idempotent, like every file here; no data statements.

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_source_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_source_check
  CHECK (source IN ('internal_analysis', 'claude_research', 'user_request', 'dataforseo_demand', 'competitor_footprint'));

ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS opportunity_type    TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS opportunity_score   NUMERIC(4,3);
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS competitor_evidence JSONB;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS keyword_difficulty  INTEGER;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS our_position        NUMERIC(6,2);
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS best_competitor_position INTEGER;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS lifecycle_state     TEXT NOT NULL DEFAULT 'discovered';
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_opportunity_type_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_opportunity_type_check
  CHECK (opportunity_type IS NULL OR opportunity_type IN
    ('missing', 'position_gap', 'topic_gap', 'service_location', 'improve_page', 'new_page'));

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_opportunity_score_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_opportunity_score_check
  CHECK (opportunity_score IS NULL OR (opportunity_score >= 0 AND opportunity_score <= 1));

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_keyword_difficulty_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_keyword_difficulty_check
  CHECK (keyword_difficulty IS NULL OR (keyword_difficulty >= 0 AND keyword_difficulty <= 100));

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_lifecycle_state_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_lifecycle_state_check
  CHECK (lifecycle_state IN ('discovered', 'drafted', 'merged', 'deployed', 'verified'));

-- The read the scorer and the ship cycle need: this project's open opportunities, best first.
CREATE INDEX IF NOT EXISTS keyword_gaps_opportunity_idx
  ON keyword_gaps (site_id, status, opportunity_score DESC NULLS LAST);

-- Verified outcomes per opportunity type: what behaviour learning reads to decide which kinds of work actually pay off
-- for this project. One row per (site, opportunity_type), updated as outcomes are verified — never from an opened PR.
CREATE TABLE IF NOT EXISTS opportunity_type_outcomes (
  site_id          INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_type TEXT        NOT NULL,
  verified_total   INTEGER     NOT NULL DEFAULT 0 CHECK (verified_total >= 0),
  verified_positive INTEGER    NOT NULL DEFAULT 0 CHECK (verified_positive >= 0),
  verified_negative INTEGER    NOT NULL DEFAULT 0 CHECK (verified_negative >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, opportunity_type),
  CHECK (verified_positive + verified_negative <= verified_total)
);

ALTER TABLE opportunity_type_outcomes ENABLE ROW LEVEL SECURITY;
