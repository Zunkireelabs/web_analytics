-- PROPOSED, not applied (moved out of server/migrations so nothing runs before approval).
-- One row per project, per day, per stage of the unified daily pipeline (server/lib/daily-pipeline/).
--
-- WHY A TABLE. The pipeline runs a project through research, design baseline, analyst, generate and prepare in one morning.
-- A deploy, a crash, a missed wake-up or a deadline can land between any two stages, and the next pass has to know exactly
-- how far each project got without redoing (or double-shipping) anything. Nothing else records "project X finished the
-- analyst stage today": recommendations and the shipping queue say what work exists, not which stage produced it.
--
-- One row is one (project, day, stage). UNIQUE makes a stage idempotent: two processes, or a resumed run, cannot both start
-- the same stage for the same project and day. `attempts` is the bounded-retry counter. `deferred` means the stage did not
-- start because the day's deadline had passed; its work stays queued for the next cycle.
--
-- Each project's rows are its own: nothing here joins one project to another, so no data or memory crosses between clients.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS daily_pipeline_runs (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  run_date    DATE        NOT NULL,
  stage       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'running',
  attempts    INTEGER     NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error       TEXT,
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE daily_pipeline_runs DROP CONSTRAINT IF EXISTS daily_pipeline_runs_status_check;
ALTER TABLE daily_pipeline_runs ADD CONSTRAINT daily_pipeline_runs_status_check
  CHECK (status IN ('running', 'done', 'failed', 'deferred', 'skipped'));

CREATE UNIQUE INDEX IF NOT EXISTS daily_pipeline_runs_site_day_stage_uniq ON daily_pipeline_runs (site_id, run_date, stage);
CREATE INDEX IF NOT EXISTS daily_pipeline_runs_day_status_idx ON daily_pipeline_runs (run_date, status);
