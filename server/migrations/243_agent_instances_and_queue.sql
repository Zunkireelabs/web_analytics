-- P2 (Agent Factory) and P3 (Master Agent queue). Additive and idempotent; NO data statements, so no existing project, job or
-- schedule changes when this is applied. Nothing reads these tables unless the Agent Factory is called or MASTER_AGENT_MODE is
-- 'shadow' or 'on' (default 'off').
--
-- agent_instances: one row per project, created at project creation (db.js createClientSite) or lazily by the factory. It records
--   where the project's Growth Agent is in its lifecycle and what each provisioning step last reported. A project with no row is
--   simply "not yet seen by the factory": the admin view derives its state from the site row and does not need this table.
--
-- instance_jobs: the Master Agent's work queue, one row per (project, kind, day). The unique key is what makes planning safe to
--   repeat: planning twice in a day cannot create a second job, and a restart cannot run a day twice. Claiming uses
--   FOR UPDATE SKIP LOCKED so two workers never take the same job, and a claimed job carries a lease so a killed worker's job
--   is picked up again rather than lost.
CREATE TABLE IF NOT EXISTS agent_instances (
  site_id            INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  lifecycle_state    TEXT NOT NULL DEFAULT 'requested',
  steps              JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error         TEXT,
  last_reconciled_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_instances DROP CONSTRAINT IF EXISTS agent_instances_state_check;
ALTER TABLE agent_instances ADD CONSTRAINT agent_instances_state_check
  CHECK (lifecycle_state IN ('requested','provisioning','connecting','baselining','active','paused','offboarding','removed'));

CREATE TABLE IF NOT EXISTS instance_jobs (
  id               BIGSERIAL PRIMARY KEY,
  site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  run_day          DATE NOT NULL,
  state            TEXT NOT NULL DEFAULT 'queued',
  mode             TEXT NOT NULL DEFAULT 'on',
  priority         INTEGER NOT NULL DEFAULT 100,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 2,
  run_after        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by        TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  duration_ms      INTEGER,
  estimate_ms      INTEGER,
  error            TEXT,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, kind, run_day)
);
ALTER TABLE instance_jobs DROP CONSTRAINT IF EXISTS instance_jobs_state_check;
ALTER TABLE instance_jobs ADD CONSTRAINT instance_jobs_state_check
  CHECK (state IN ('queued','running','succeeded','failed','timed_out','skipped'));
CREATE INDEX IF NOT EXISTS idx_instance_jobs_claim ON instance_jobs (state, run_after, priority, id);
CREATE INDEX IF NOT EXISTS idx_instance_jobs_day ON instance_jobs (run_day, site_id);

ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_jobs ENABLE ROW LEVEL SECURITY;
