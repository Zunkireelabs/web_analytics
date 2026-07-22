-- Phase 1 of free backlink/referring-domain data from Common Crawl's host-
-- level webgraph (see ai-growth-platform backlinks plan). Deliberately new,
-- dedicated tables rather than touching authority_snapshots (migration 035)
-- or anything DataForSEO-backed — Common Crawl is a separate, free data
-- source that must not change the existing Authority Score's behavior.
--
-- Data flow (see also server/providers/backlinks/provider.js):
--   1. ETL imports (not yet built) parse Common Crawl webgraph releases and
--      populate these tables. This is the only layer allowed to write here.
--   2. Providers (server/providers/backlinks/) read from these tables (or,
--      for other providers like DataForSEO, call a live API) and expose the
--      same shared contract regardless of source.
--   3. Agents consume providers, never these tables or a specific vendor
--      API directly.
--   4. The dashboard consumes agents/API output only — no direct DB or
--      provider access.
--
-- No ETL, provider implementation, or dashboard UI is added in this phase.

-- Raw referring-domain relationships as published in one Common Crawl
-- webgraph release. One row per (target, source, release) edge; re-running
-- an import for the same release is idempotent via the unique constraint.
CREATE TABLE IF NOT EXISTS commoncrawl_referring_domains (
  id            SERIAL PRIMARY KEY,
  target_domain TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  graph_release TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_domain, source_domain, graph_release)
);

CREATE INDEX IF NOT EXISTS idx_commoncrawl_referring_domains_target
  ON commoncrawl_referring_domains (target_domain);
CREATE INDEX IF NOT EXISTS idx_commoncrawl_referring_domains_source
  ON commoncrawl_referring_domains (source_domain);
CREATE INDEX IF NOT EXISTS idx_commoncrawl_referring_domains_release
  ON commoncrawl_referring_domains (graph_release);

-- Per-domain rollup for one graph release (referring-domain count, graph
-- rank) — the pre-aggregated summary a provider reads instead of counting
-- raw edges on every request. One row per domain per release.
CREATE TABLE IF NOT EXISTS commoncrawl_domain_summary (
  id                SERIAL PRIMARY KEY,
  domain            TEXT NOT NULL,
  referring_domains INT,
  graph_rank        BIGINT,
  graph_release     TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, graph_release)
);

CREATE INDEX IF NOT EXISTS idx_commoncrawl_domain_summary_domain
  ON commoncrawl_domain_summary (domain);
CREATE INDEX IF NOT EXISTS idx_commoncrawl_domain_summary_release
  ON commoncrawl_domain_summary (graph_release);
