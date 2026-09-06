-- System-wide shared agent fix memory. Replaces fix_lessons (content-generation
-- corrections, per-generator) and engineering_fix_lessons (code-bug lessons,
-- no runtime consumer) with one table any agent can read from and write to,
-- keyed on a generalized problem pattern rather than a literal URL/file/client,
-- so a fix learned on one client/generator/repo is retrievable for another.
--
-- category/scope/execution_permission together are the safety gate: a
-- client-facing content generator must never retrieve category='code' rows
-- (enforced in server/agent-memory.js's findRelevantMemory, not just here),
-- and execution_permission distinguishes "safe to auto-apply the fix_pattern
-- text" from "surface as an advisory warning only".
--
-- All column types are plain SQL with no Node-specific concepts, since a
-- planned Phase 2 lets the separate Python data-analyst-agent service read
-- this same table (via an internal API) without a schema change.
CREATE TABLE IF NOT EXISTS agent_fix_memory (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('content','technical-seo','code','data-analytics','infrastructure','other')),
  scope TEXT NOT NULL CHECK (scope IN ('client','repo','global')),
  execution_permission TEXT NOT NULL DEFAULT 'requires_approval'
    CHECK (execution_permission IN ('auto','requires_approval','informational')),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','trusted','flagged_for_review','deprecated')),
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,       -- NULL = cross-tenant wildcard
  generator_id TEXT,                                             -- NULL = applies to any generator/agent
  problem_signature TEXT NOT NULL,       -- generalized key, e.g. "missing-alt-text:decorative-svg"
  symptoms TEXT NOT NULL,
  root_cause TEXT,
  affected_pattern TEXT NOT NULL,        -- generalized description, never a literal URL/file/client
  fix_strategy TEXT NOT NULL,
  fix_pattern TEXT,                      -- optional reusable template/content fragment
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  successful_reuse_count INTEGER NOT NULL DEFAULT 0,
  failed_reuse_count INTEGER NOT NULL DEFAULT 0,
  reuse_history JSONB NOT NULL DEFAULT '[]',  -- [{agentId, generatorId, siteId, timestamp, outcome, notes}]
  source_type TEXT NOT NULL DEFAULT 'runtime-auto'
    CHECK (source_type IN ('runtime-auto','human-edit','regression','backfill-migrated','manual')),
  source_ref TEXT,
  validation_rule_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_fix_memory_retrieval
  ON agent_fix_memory (category, scope, status) WHERE status != 'deprecated';
CREATE INDEX IF NOT EXISTS idx_agent_fix_memory_site ON agent_fix_memory (site_id);
CREATE INDEX IF NOT EXISTS idx_agent_fix_memory_rule ON agent_fix_memory (validation_rule_id, generator_id, site_id);
