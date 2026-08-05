-- Phase 4 M1: the Recommendation Coordinator's persisted store. This is the
-- ONLY table the Action Center's recommendation list is allowed to read from
-- going forward — Search Analytics agents still produce ephemeral Finding[]
-- exactly as before (see agents/lib/recommendations.js's buildRecommendations,
-- left untouched), the coordinator (agents/lib/recommendation-coordinator.js)
-- is what turns that grounded output into these rows, merging duplicate
-- findings for the same page + recommendation_type into one row instead of
-- one-per-detecting-agent.
--
-- Columns left null/default in M1 (confidence, risk_tier, execution_job_id,
-- verification_status) are reserved for later milestones (Data Analyst
-- enrichment, safe-execution gating, the Execution Engine, post-execution
-- verification) so this table doesn't need another shape-changing migration
-- when those land.
CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  page TEXT NOT NULL DEFAULT '',
  recommendation_type TEXT NOT NULL,
  issue TEXT NOT NULL,
  reason TEXT,
  params JSONB NOT NULL DEFAULT '{}',
  finding_ids TEXT[] NOT NULL DEFAULT '{}',
  detecting_agents TEXT[] NOT NULL DEFAULT '{}',
  supporting_agents TEXT[] NOT NULL DEFAULT '{}',
  confidence NUMERIC,
  priority TEXT NOT NULL DEFAULT 'medium',
  expected_impact JSONB,
  risk_tier TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'superseded')),
  execution_job_id INTEGER,
  verification_status TEXT,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforces "never duplicate for the same page + recommendation type" at the
-- DB level rather than by convention. Partial so a dismissed/superseded row
-- doesn't block a fresh recommendation from being opened for the same key.
CREATE UNIQUE INDEX IF NOT EXISTS recommendations_dedup_key
  ON recommendations (site_id, page, recommendation_type)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS recommendations_site_status_idx ON recommendations (site_id, status);
