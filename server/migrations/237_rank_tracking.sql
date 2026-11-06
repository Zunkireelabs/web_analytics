-- Rank tracking (keyword position history) — the deliberate list, and the caps that stop it spending.
--
-- DELIBERATELY NO NEW SNAPSHOT TABLE. `competitor_rankings` (migration 018) already stores exactly a rank snapshot:
-- one row per (site, date, query, domain) with url, position and is_own_domain, with history, an upsert and read
-- functions already in use by the competitor-intelligence agent. A parallel table would mean two answers to "who
-- ranked where for this query on this date".
--
-- What was genuinely missing is WHICH queries get checked. Today the weekly job checks the site's own top ~40 Search
-- Console queries, so it can only ever see keywords the site ALREADY ranks for — the ones we most need to watch (a
-- keyword a rival owns and we have no presence for) are invisible to it. This table is that missing list: keywords a
-- human or an accepted opportunity deliberately chose to watch, whether or not the site ranks for them yet.
--
-- COST CONTROL IS THE POINT OF THIS MIGRATION. Five independent limits, so no single mistake can burn money:
--   1. `sites.rank_tracking_enabled` DEFAULT false      - off for every site until deliberately switched on
--   2. `sites.rank_tracking_max_keywords` DEFAULT 25    - a hard per-site ceiling on how many are ever checked
--   3. `tracked_keywords.active`                        - a keyword can be paused without losing its history
--   4. `sites.rank_tracking_last_done` + a cadence      - checked weekly, not daily
--   5. the spend ledger and monthly budget (231)        - the backstop that refuses the call outright
-- A keyword also only enters this table from a named `source`, never from a bulk import of everything the site ranks
-- for: that is how a tracked list quietly grows into a bill.
--
-- Additive and idempotent, like every file here; no data statements — no site is opted in and no keyword is tracked.
CREATE TABLE IF NOT EXISTS tracked_keywords (
  id            SERIAL      PRIMARY KEY,
  site_id       INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword       TEXT        NOT NULL,
  location_code INTEGER     NOT NULL,
  language_code TEXT        NOT NULL DEFAULT 'en',
  -- Where the decision to watch this keyword came from. 'opportunity' is the automated path: a competitor
  -- opportunity that was actually shipped, so its target keyword is worth watching. Everything else is a person.
  source        TEXT        NOT NULL CHECK (source IN ('user_request', 'opportunity', 'keyword_gap', 'baseline')),
  active        BOOLEAN     NOT NULL DEFAULT true,
  gap_id        INTEGER     REFERENCES keyword_gaps(id) ON DELETE SET NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  UNIQUE (site_id, keyword, location_code)
);
-- The check run's own lookup: this project's active keywords, longest-unchecked first, so a capped run rotates
-- fairly instead of always re-checking the same first N.
CREATE INDEX IF NOT EXISTS tracked_keywords_due_idx
  ON tracked_keywords (site_id, last_checked_at ASC NULLS FIRST) WHERE active = true;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS rank_tracking_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS rank_tracking_max_keywords INTEGER NOT NULL DEFAULT 25;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS rank_tracking_last_done    TIMESTAMPTZ;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_rank_tracking_max_keywords_check;
ALTER TABLE sites ADD CONSTRAINT sites_rank_tracking_max_keywords_check
  CHECK (rank_tracking_max_keywords >= 0 AND rank_tracking_max_keywords <= 500);

CREATE INDEX IF NOT EXISTS sites_rank_tracking_due_idx
  ON sites (rank_tracking_last_done) WHERE rank_tracking_enabled = true;

ALTER TABLE tracked_keywords ENABLE ROW LEVEL SECURITY;
