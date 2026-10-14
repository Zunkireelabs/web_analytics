-- Real DataForSEO Keyword Data ("keyword ideas") ingest, run once a month
-- per site — the search-volume counterpart to the existing monthly
-- competitor-SERP cadence (see job.js's runCompetitorCheckIfDue). Seed terms
-- come from the site's OWN crawled homepage content (what it actually
-- offers), not a guess; the resulting keywords are saved into keyword_gaps
-- (source='dataforseo_demand') for the existing weekly ship cycle to draw
-- blog drafts and on-page keyword updates from across the rest of the month
-- — see server/agents/lib/keyword-demand.js.
--
-- Own marker table, not a sites column, matching competitor_rankings'
-- precedent: real persisted history of when the account was actually
-- charged for volume data, useful on its own for cost auditing.
CREATE TABLE IF NOT EXISTS keyword_demand_runs (
  id             SERIAL PRIMARY KEY,
  site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  seed_terms     JSONB NOT NULL,
  keywords_found INT NOT NULL DEFAULT 0,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_keyword_demand_runs_site_date ON keyword_demand_runs (site_id, checked_at DESC);

-- 'dataforseo_demand' gaps behave exactly like 'claude_research' ones
-- through qualifyAndShipContentGaps/createActionCenterRecommendationForGap
-- (neither function branches on source) — the only difference is these are
-- backed by real DataForSEO search volume instead of an LLM guess. Keeps
-- migration 099's 'user_request' value too — this only adds a new source,
-- never narrows the existing set.
ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_source_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_source_check
  CHECK (source IN ('internal_analysis', 'claude_research', 'user_request', 'dataforseo_demand'));
