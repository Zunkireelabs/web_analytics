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
--
-- Guarded by a name-existence check, not a plain `IF NOT EXISTS`: migration
-- 045 renames this table to commoncrawl_backlink_domains right after it's
-- created. A plain `CREATE TABLE IF NOT EXISTS` here is only safe the FIRST
-- time this migration set runs — once 045 has renamed it away, "IF NOT
-- EXISTS commoncrawl_referring_domains" is true again (that name no longer
-- exists) and would recreate an empty duplicate, which then makes 045's
-- rename fail with "relation already exists" on any full re-run of the
-- migration set (confirmed — this exact bug hit the real dev DB). Checking
-- both the old AND the already-renamed-to name makes this genuinely
-- idempotent across any number of re-runs, matching this migration
-- runner's documented "safe to re-run" contract (server/migrations/run.js).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'commoncrawl_referring_domains')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'commoncrawl_backlink_domains') THEN
    CREATE TABLE commoncrawl_referring_domains (
      id            SERIAL PRIMARY KEY,
      target_domain TEXT NOT NULL,
      source_domain TEXT NOT NULL,
      graph_release TEXT NOT NULL,
      fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (target_domain, source_domain, graph_release)
    );
    CREATE INDEX idx_commoncrawl_referring_domains_target ON commoncrawl_referring_domains (target_domain);
    CREATE INDEX idx_commoncrawl_referring_domains_source ON commoncrawl_referring_domains (source_domain);
    CREATE INDEX idx_commoncrawl_referring_domains_release ON commoncrawl_referring_domains (graph_release);
  END IF;
END $$;

-- Per-domain rollup for one graph release (referring-domain count, graph
-- rank) — the pre-aggregated summary a provider reads instead of counting
-- raw edges on every request. One row per domain per release. Same
-- both-names guard as above, for the same reason (migration 045 renames
-- this one to commoncrawl_backlink_summary).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'commoncrawl_domain_summary')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'commoncrawl_backlink_summary') THEN
    CREATE TABLE commoncrawl_domain_summary (
      id                SERIAL PRIMARY KEY,
      domain            TEXT NOT NULL,
      referring_domains INT,
      graph_rank        BIGINT,
      graph_release     TEXT NOT NULL,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (domain, graph_release)
    );
    CREATE INDEX idx_commoncrawl_domain_summary_domain ON commoncrawl_domain_summary (domain);
    CREATE INDEX idx_commoncrawl_domain_summary_release ON commoncrawl_domain_summary (graph_release);
  END IF;
END $$;
