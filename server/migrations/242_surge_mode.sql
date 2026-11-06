-- FIRST-30-DAY SURGE MODE + an atomic daily ceiling.
--
-- 1. sites.surge_mode_until: while this is in the future, the project's daily autonomous capacity may rise from the
--    default 60 up to the platform's hard 100. NULL = off. There is deliberately no default and no backfill: every
--    existing project gets NULL, so nothing changes for anyone until a person sets a future date by hand. New projects
--    are given now() + 30 days by createClientSite() (db.js). Expiry needs no job: the date simply passes.
--
-- 2. autonomous_daily_slots: one row per (site, local day) counting the autonomous work already taken. A slot is taken
--    with a single atomic UPDATE ... WHERE used < cap, so two simultaneous runs, a retry and a restart cannot both take
--    the last slot. The old way (read a count, then act) left a window between the read and the act.
--
-- Additive and idempotent; no existing row is changed.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS surge_mode_until TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS autonomous_daily_slots (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day        DATE    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, day)
);

ALTER TABLE autonomous_daily_slots ENABLE ROW LEVEL SECURITY;
