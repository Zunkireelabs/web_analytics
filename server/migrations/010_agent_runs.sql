-- Append-only log of every AI Agent run (AI Growth Platform framework).
-- Unlike daily_reports' upsert-by-day pattern, a run has no side effect to
-- guard against duplicates — keeping every row is the point (history/audit/
-- future trend views), so this table is only ever inserted into, never updated.
CREATE TABLE IF NOT EXISTS agent_runs (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  agent_version INT NOT NULL DEFAULT 1,
  input         JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ok',
  facts         JSONB,
  narrative     TEXT,
  error         TEXT,
  took_ms       INT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_lookup ON agent_runs (site_id, agent_id, created_at DESC);
