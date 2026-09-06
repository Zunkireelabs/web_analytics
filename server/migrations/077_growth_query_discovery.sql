-- Growth Query Discovery: the persisted "query universe" a site is tracked
-- against, discovered from real GSC data and LLM-reasoned category
-- expansion grounded in the site's own content (same non-fabrication
-- discipline as ai_tracked_prompts/generatePromptCandidates). Rotating, not
-- deleted-on-drop, so historical growth_query_checks/ai_prompt_runs rows
-- keep a real query_text to join against even after a query goes inactive.
CREATE TABLE IF NOT EXISTS tracked_growth_queries (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query_text    TEXT NOT NULL,
  query_type    TEXT NOT NULL, -- 'gsc-near-miss' | 'gsc-uncovered' | 'llm-category' | 'llm-comparison' | 'llm-question'
  source        TEXT NOT NULL, -- 'gsc' | 'llm'
  active        BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, query_text)
);

-- Current coverage judgment per tracked query — one row, updated in place
-- each cycle (not append-only; per-query history lives in
-- growth_query_checks below).
CREATE TABLE IF NOT EXISTS growth_query_status (
  site_id           INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query_id          INT NOT NULL REFERENCES tracked_growth_queries(id) ON DELETE CASCADE,
  coverage_status   TEXT NOT NULL DEFAULT 'missing', -- 'missing' | 'partial' | 'covered'
  covered_by_page   TEXT,
  incumbent_note    TEXT,       -- set when the niche-relative heuristic judges the query too broad for this site to target directly
  last_checked_at   TIMESTAMPTZ,
  drafted_at        TIMESTAMPTZ,
  PRIMARY KEY (site_id, query_id)
);

-- Append-only verification history — one row per real check (Google CSE
-- presence spot-check, or a real-GSC-impressions-now-exist confirmation).
-- AI-mention verification deliberately reuses ai_prompt_runs directly (via
-- ai_tracked_prompts.growth_query_id below) rather than a third parallel
-- table.
CREATE TABLE IF NOT EXISTS growth_query_checks (
  id          SERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query_id    INT NOT NULL REFERENCES tracked_growth_queries(id) ON DELETE CASCADE,
  check_type  TEXT NOT NULL,  -- 'google-cse' | 'gsc-impressions'
  found       BOOLEAN,
  position    INT,
  detail      JSONB,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_growth_query_checks_lookup ON growth_query_checks (site_id, query_id, checked_at DESC);

-- Links a growth-query-derived AI probe prompt back to its source query, so
-- the AI-mention check reuses ai-recommendation.js's existing
-- probe/detectMention/ai_prompt_runs pipeline directly instead of a
-- parallel implementation. No CHECK constraint exists on
-- ai_tracked_prompts.source today, so adding a new 'growth-query' source
-- value needs no constraint change.
ALTER TABLE ai_tracked_prompts ADD COLUMN IF NOT EXISTS growth_query_id INT REFERENCES tracked_growth_queries(id) ON DELETE SET NULL;

-- No idempotency column needed here (unlike geo-audit's sites.geo_audit_last_done):
-- growth-queries is a real AGENT (runs through server/agents/runner.js into
-- agent_runs), so its weekly gate reuses the existing generic
-- runAgentIfDue(site, 'growth-queries', {cadence:'week'}) helper in
-- server/job.js — the same mechanism competitor-intelligence/authority/
-- ai-recommendation already use, which reads agent_runs directly with zero
-- extra schema.
