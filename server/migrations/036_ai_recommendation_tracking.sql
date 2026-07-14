-- Real ChatGPT-recommendation tracking (server/agents/ai-recommendation.js —
-- distinct from ai-visibility.js, which only measures structural readiness,
-- never actual AI-engine citation).
--
-- ai_tracked_prompts is the rotating "prompt universe" derived from the
-- site's own real data (company name, services, top landing pages, top GSC
-- queries) — active/inactive rather than deleted, so historical
-- ai_prompt_runs rows keep a real prompt_text to join against even after a
-- prompt rotates out.
CREATE TABLE IF NOT EXISTS ai_tracked_prompts (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt_text   TEXT NOT NULL,
  source        TEXT NOT NULL, -- 'service' | 'landing-page' | 'top-query'
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, prompt_text)
);

-- Append-only, same convention as agent_runs — one row per real prompt
-- probe. `mentioned` is verified deterministically in JS (a real string/
-- domain match against raw_response), never trusted from the model's own
-- self-report of a checkable fact — see the agent's own comments.
-- raw_response is kept in full for audit, same "no black box" discipline as
-- authority_snapshots.raw_summary.
CREATE TABLE IF NOT EXISTS ai_prompt_runs (
  id                      SERIAL PRIMARY KEY,
  site_id                 INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt_id               INT NOT NULL REFERENCES ai_tracked_prompts(id) ON DELETE CASCADE,
  model                   TEXT NOT NULL,
  run_date                DATE NOT NULL,
  raw_response            TEXT,
  mentioned               BOOLEAN NOT NULL,
  approximate_position    INT,
  competitors_mentioned   JSONB,
  sentiment               TEXT,
  recommendation_strength TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_runs_site_date
  ON ai_prompt_runs (site_id, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_runs_prompt
  ON ai_prompt_runs (prompt_id, run_date DESC);
