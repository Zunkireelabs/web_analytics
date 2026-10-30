-- Plain-language growth goal per project ("what do you want to grow, how much,
-- in how long"), set from the workspace screens by non-technical users.
--
--   goal    what matters most: google_visitors | enquiries | ai_answers | key_rankings
--   growth  how much: steady (~20%) | fast (~50%) | ambitious (double)
--   months  how long: 3 | 6 | 12
--
-- Kept separate from growth_targets (047), which holds the numeric
-- "here to here" targets the Milestones page charts. This table records the
-- person's intent; a change supersedes the active row rather than overwriting
-- it, so history stays queryable, the same posture growth_targets takes.
--
-- Additive only and idempotent: this directory re-applies every file on every
-- deploy, so schema statements use IF NOT EXISTS / DROP-then-ADD and there are
-- no data statements.

CREATE TABLE IF NOT EXISTS project_goals (
  id         SERIAL PRIMARY KEY,
  site_id    INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  goal       TEXT NOT NULL,
  growth     TEXT NOT NULL,
  months     INT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_goal_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_goal_check
  CHECK (goal IN ('google_visitors', 'enquiries', 'ai_answers', 'key_rankings'));

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_growth_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_growth_check
  CHECK (growth IN ('steady', 'fast', 'ambitious'));

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_months_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_months_check
  CHECK (months IN (3, 6, 12));

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_status_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_status_check
  CHECK (status IN ('active', 'superseded'));

-- At most one active goal per project.
CREATE UNIQUE INDEX IF NOT EXISTS project_goals_active_unique
  ON project_goals (site_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_project_goals_site ON project_goals (site_id, created_at DESC);
