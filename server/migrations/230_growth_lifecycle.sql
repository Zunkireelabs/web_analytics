-- Growth lifecycle + always-on learning (activation).
--
-- 1. GROWTH CLOCK. sites.growth_started_at is when a project's 30 / 30 / ongoing growth programme began.
--      - A client that exists when this migration first runs starts its Day 1 AT THAT MOMENT (the deployment): nobody is
--        treated as having finished a stage they never had, and no existing data, baseline or history is touched.
--      - Every project created after that gets the column default (now() at creation) = Day 1 automatically, with no code
--        in the onboarding flow that could be forgotten.
--    Re-running changes nothing (IF NOT EXISTS), so a later deploy never resets anyone's clock.
-- 2. growth_stage_log: the stages each project has been through and when (one row per project per stage).
-- 3. platform_activations: markers for ONE-TIME switch-ons, so a data change runs once and a later deliberate per-project
--    decision is never overwritten by a redeploy (migrations run on every deploy; see migrations.test.js).
-- 4. The decision engine's per-project switch (sites.decision_engine_default_bucket_enabled) becomes ON by default and is
--    turned on once for projects that exist now. A project can still be switched off afterwards and stays off.
--
-- Additive and convergent.
-- ADD COLUMN ... DEFAULT now() (not ADD COLUMN + UPDATE): every existing row reads the moment this ran, with no row rewrite.
-- An UPDATE here would re-check each rewritten row's foreign keys for the rest of the transaction, and rows whose
-- baseline_run_id points at a pruned agent_runs row (found in a real database) would then fail the whole deploy.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS growth_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS growth_stage_log (
  id          BIGSERIAL   PRIMARY KEY,
  site_id     INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  stage       TEXT        NOT NULL CHECK (stage IN ('acceleration', 'expansion', 'optimisation')),
  day         INTEGER     NOT NULL,
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, stage)
);
CREATE INDEX IF NOT EXISTS growth_stage_log_site_idx ON growth_stage_log (site_id, entered_at DESC);
ALTER TABLE growth_stage_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_activations (
  key         TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      TEXT        NOT NULL DEFAULT ''
);
ALTER TABLE platform_activations ENABLE ROW LEVEL SECURITY;

ALTER TABLE sites ALTER COLUMN decision_engine_default_bucket_enabled SET DEFAULT true;
UPDATE sites SET decision_engine_default_bucket_enabled = true
 WHERE decision_engine_default_bucket_enabled = false
   AND NOT EXISTS (SELECT 1 FROM platform_activations WHERE key = 'decision-engine-default-bucket-on');
INSERT INTO platform_activations (key, detail) VALUES ('decision-engine-default-bucket-on', 'switched on for existing projects; default true for new ones')
ON CONFLICT (key) DO NOTHING;
