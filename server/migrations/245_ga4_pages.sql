-- Google Analytics "Views by page title", one row per page per day, for the Overview's Visitors tab ("Top pages").
--
-- A separate table beside ga4_breakdown rather than a new dim_type there: those rows are (sessions, users) pairs for
-- a handful of values, while this is a long-tailed list of free-text page titles measured in VIEWS. Different metric,
-- different cardinality, different reader.
--
-- Only the day's top 25 titles are stored (see PAGES_PER_DAY in ingest/ga4.js), so this table is a top-N, never the
-- complete page list; how much of the day's views it covers is recorded next to the day's other quality notes in
-- ga4_daily.data_quality->'pages' (migration 238's column, no schema change needed).
--
-- `users` is kept per day but must never be SUMMED across days by a reader: a returning person is a user on each day,
-- so a period total would overstate reach. The route returns views only for that reason.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS ga4_pages (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date       DATE    NOT NULL,
  page_title TEXT    NOT NULL,
  views      INTEGER NOT NULL CHECK (views >= 0),
  users      INTEGER NOT NULL DEFAULT 0 CHECK (users >= 0),
  PRIMARY KEY (site_id, date, page_title)
);

-- The Overview's read: one project, a date range.
CREATE INDEX IF NOT EXISTS ga4_pages_site_date_idx ON ga4_pages (site_id, date);

ALTER TABLE ga4_pages ENABLE ROW LEVEL SECURITY;
