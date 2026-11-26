-- Keyword discovery: one visible row per project per discovery path saying what the last attempt did and, when it found nothing, WHY in words a
-- person can act on (no credit on the data source, the project has no connection token, no search data yet, ...). Before this, every
-- skip was a console line ("no real offering terms could be extracted") that hid the real cause for weeks.
-- Additive: a new table and one widened CHECK. No data statements. Every row is scoped by site_id; nothing is shared between projects.
CREATE TABLE IF NOT EXISTS keyword_discovery_status (
  site_id     INT         NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path        TEXT        NOT NULL,                 -- dataforseo_demand | own_search_queries
  status      TEXT        NOT NULL,                 -- ok | nothing_new | blocked | skipped
  reason_code TEXT,                                 -- machine-readable, e.g. dataforseo_payment_required
  message     TEXT        NOT NULL,                 -- plain words: what happened and what to do
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  keywords    INT         NOT NULL DEFAULT 0,       -- keywords saved by that attempt
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, path)
);

-- Keywords found from a project's OWN Search Console queries (real impressions/position, no search-volume figure is ever attached).
ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_source_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_source_check
  CHECK (source IN ('internal_analysis', 'claude_research', 'user_request', 'dataforseo_demand', 'competitor_footprint', 'gsc_own_queries'));
