-- Lean, append-only operational telemetry for the agentic tool-calling loop
-- (agents/lib/agentic-orchestrator.js). Deliberately carries NO question
-- text, NO narrative, NO findings content — same "real events only, never
-- synthesized" discipline migration 021 (notifications) established.
CREATE TABLE IF NOT EXISTS agentic_orchestration_runs (
  id                SERIAL PRIMARY KEY,
  site_id           INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('question', 'selection')),
  rounds_used       INT NOT NULL,
  tool_calls_used   INT NOT NULL,
  tool_ids_used     TEXT[] NOT NULL DEFAULT '{}',
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  took_ms           INT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_orchestration_runs_site ON agentic_orchestration_runs (site_id, created_at DESC);
