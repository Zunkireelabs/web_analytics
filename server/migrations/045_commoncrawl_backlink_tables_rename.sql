-- Phase 2 of the Common Crawl backlinks work (see migration 044's header for
-- the overall ETL -> providers -> agents -> dashboard data flow this is part
-- of). Renames migration 044's two tables to the names the ETL script
-- (server/scripts/refresh-commoncrawl-graph.js) and its store module
-- (server/store/commoncrawl-backlinks.js) use, and adds a third table to
-- track graph release metadata/progress — safe because both tables are still
-- empty (no ETL has run yet) and nothing outside this migration and Phase 2's
-- new code references the old names.
ALTER TABLE IF EXISTS commoncrawl_referring_domains RENAME TO commoncrawl_backlink_domains;
ALTER TABLE IF EXISTS commoncrawl_domain_summary RENAME TO commoncrawl_backlink_summary;

ALTER INDEX IF EXISTS idx_commoncrawl_referring_domains_target RENAME TO idx_commoncrawl_backlink_domains_target;
ALTER INDEX IF EXISTS idx_commoncrawl_referring_domains_source RENAME TO idx_commoncrawl_backlink_domains_source;
ALTER INDEX IF EXISTS idx_commoncrawl_referring_domains_release RENAME TO idx_commoncrawl_backlink_domains_release;
ALTER INDEX IF EXISTS idx_commoncrawl_domain_summary_domain RENAME TO idx_commoncrawl_backlink_summary_domain;
ALTER INDEX IF EXISTS idx_commoncrawl_domain_summary_release RENAME TO idx_commoncrawl_backlink_summary_release;

-- One row per Common Crawl web graph release the ETL has attempted. Lets a
-- re-run of the refresh script know whether the latest available release is
-- already done (status = 'completed', skip entirely), was left mid-stream by
-- a crash (status = 'running', resume rather than restart from byte zero —
-- see the script's resumable-download logic), or needs retrying
-- (status = 'failed'). edges_scanned/edges_matched are BIGINT: the domain-
-- level edges file runs into the billions of rows, well past INT range.
CREATE TABLE IF NOT EXISTS commoncrawl_graph_releases (
  id                     SERIAL PRIMARY KEY,
  graph_release          TEXT NOT NULL UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  vertices_url           TEXT,
  edges_url              TEXT,
  ranks_url              TEXT,
  tracked_domains_count  INT,
  vertices_matched       INT,
  edges_scanned          BIGINT NOT NULL DEFAULT 0,
  edges_matched          BIGINT NOT NULL DEFAULT 0,
  source_domains_resolved INT,
  error_message          TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_commoncrawl_graph_releases_status
  ON commoncrawl_graph_releases (status);
