-- Set the per-site auto-remediation daily budget back to 60/day.
--
-- Migration 152 lifted it to 100 (the platform's hard maximum in lib/autonomous-quota.js) to work
-- through a large queue of open recommendations. The intended steady state for every project,
-- new ones included, is 60 a day, so the default drops to 60 and every site still sitting at the
-- 100 that 152 put there follows it.
--
-- Still a CEILING, not a goal: a site with 12 eligible safe-tier items ships 12, not 60. The
-- analyst lane is reserved first (ANALYST_MAX 20), so the analytics lane can take at most 40.
--
-- Only rows exactly at 100 move. A site tuned to any other value by hand keeps its own number.
ALTER TABLE sites ALTER COLUMN auto_remediation_daily_limit SET DEFAULT 60;

UPDATE sites SET auto_remediation_daily_limit = 60 WHERE auto_remediation_daily_limit = 100;
