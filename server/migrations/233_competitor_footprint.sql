-- Competitor footprint (Phase 3): what a business rival actually ranks for, and which of its pages carry that.
--
-- Why snapshots rather than a current-state table: the growth question is not only "what do they rank for" but "what
-- did they gain since last month" — a competitor adding twenty keywords on one topic is the earliest signal we can
-- get that a market is moving. A row per (site, competitor, keyword, captured_at) answers both, and lets a run be
-- compared with the previous one without a second bookkeeping table.
--
-- Only `business` competitors (migration 232) are ever collected: a directory's keyword list is not a growth plan.
-- Every row belongs to the project that paid for it. Nothing here is shared between projects.
--
-- Metrics are stored exactly as the provider returned them. A metric the response omitted is NULL — never 0 and never
-- derived — so "we did not measure this" stays distinguishable from "this is zero". `provider_cost_id` points at the
-- ledger row that paid for the data (migration 231), so any stored number can be traced back to the call that bought it.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS competitor_keyword_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  site_id           INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_domain TEXT        NOT NULL,
  keyword           TEXT        NOT NULL,
  location_code     INTEGER     NOT NULL,
  language_code     TEXT,
  position          INTEGER     CHECK (position IS NULL OR position > 0),
  ranking_url       TEXT,
  search_volume     INTEGER     CHECK (search_volume IS NULL OR search_volume >= 0),
  keyword_difficulty INTEGER    CHECK (keyword_difficulty IS NULL OR (keyword_difficulty >= 0 AND keyword_difficulty <= 100)),
  cpc               NUMERIC(10,4) CHECK (cpc IS NULL OR cpc >= 0),
  search_intent     TEXT        CHECK (search_intent IS NULL OR search_intent IN ('informational', 'commercial', 'transactional', 'navigational')),
  estimated_traffic NUMERIC(14,3) CHECK (estimated_traffic IS NULL OR estimated_traffic >= 0),
  provider_cost_id  BIGINT      REFERENCES provider_spend_ledger(id) ON DELETE SET NULL,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, competitor_domain, keyword, location_code, captured_at)
);
-- The two reads this table exists for: "this competitor's latest footprint" and "who ranks for this keyword".
CREATE INDEX IF NOT EXISTS competitor_keyword_snapshots_latest_idx
  ON competitor_keyword_snapshots (site_id, competitor_domain, captured_at DESC);
CREATE INDEX IF NOT EXISTS competitor_keyword_snapshots_keyword_idx
  ON competitor_keyword_snapshots (site_id, keyword, location_code, captured_at DESC);

CREATE TABLE IF NOT EXISTS competitor_page_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  site_id           INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_domain TEXT        NOT NULL,
  url               TEXT        NOT NULL,
  location_code     INTEGER     NOT NULL,
  estimated_traffic NUMERIC(14,3) CHECK (estimated_traffic IS NULL OR estimated_traffic >= 0),
  keyword_count     INTEGER     CHECK (keyword_count IS NULL OR keyword_count >= 0),
  top_keywords      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  provider_cost_id  BIGINT      REFERENCES provider_spend_ledger(id) ON DELETE SET NULL,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, competitor_domain, url, location_code, captured_at)
);
CREATE INDEX IF NOT EXISTS competitor_page_snapshots_latest_idx
  ON competitor_page_snapshots (site_id, competitor_domain, captured_at DESC);

-- When each competitor's footprint was last collected, so a run can skip anyone still fresh instead of paying twice.
-- One row per (site, competitor): the freshness question is about the competitor, not about any single snapshot.
CREATE TABLE IF NOT EXISTS competitor_footprint_runs (
  site_id           INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_domain TEXT        NOT NULL,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  keywords_stored   INTEGER     NOT NULL DEFAULT 0,
  pages_stored      INTEGER     NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL CHECK (status IN ('ok', 'partial', 'failed', 'budget_refused')),
  detail            TEXT,
  PRIMARY KEY (site_id, competitor_domain)
);

-- Same state as every other table in this schema (see 225): RLS on, no policies; the app connects as a role that bypasses it.
ALTER TABLE competitor_keyword_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_page_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_footprint_runs ENABLE ROW LEVEL SECURITY;
