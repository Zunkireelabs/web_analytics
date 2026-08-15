-- Raise the auto-remediation daily budget default from 30 to 60/day
-- (see migration 101 for the original reasoning — still a CEILING, not a
-- goal: a site with only 12 open safe-tier items ships 12, not 60).
--
-- Also bumps every existing site currently sitting at the old default of 30
-- — none of them have been individually tuned away from that default yet
-- (server/routes/clients.js is the only path that would have changed it, and
-- no site's value differs from 30 as of this migration), so all of them were
-- riding the default and should move with it.
ALTER TABLE sites ALTER COLUMN auto_remediation_daily_limit SET DEFAULT 60;

UPDATE sites SET auto_remediation_daily_limit = 60 WHERE auto_remediation_daily_limit = 30;
