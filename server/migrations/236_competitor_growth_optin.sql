-- Per-site opt-in for the competitor growth cycle, and its own cadence stamp.
--
-- DEFAULT false is the point of this migration. Everything in migrations 231-235 is inert until a named site is
-- switched on: deploying the whole feature changes nothing for any existing client, and a pilot is one UPDATE on one
-- site rather than an environment variable that flips every tenant at once. Same shape as the opt-ins already here
-- (auto_remediation_enabled, design_agent_enabled, learned_repair_enabled).
--
-- `competitor_growth_last_done` is the cadence stamp the cron reads, mirroring weekly_last_done / monthly_last_done:
-- the cron fires daily and each site decides whether enough time has passed, so a cadence change needs no cron change
-- and a missed night is caught up on the next run rather than skipped.
--
-- Additive and idempotent, like every file here; no data statements — no existing site is opted in by this migration.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS competitor_growth_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS competitor_growth_last_done TIMESTAMPTZ;

-- The cron's own lookup: which sites are switched on, oldest run first.
CREATE INDEX IF NOT EXISTS sites_competitor_growth_due_idx
  ON sites (competitor_growth_last_done) WHERE competitor_growth_enabled = true;
