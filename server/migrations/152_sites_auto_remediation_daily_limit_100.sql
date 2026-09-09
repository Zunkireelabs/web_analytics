-- Raise the per-site auto-remediation daily budget to 100/day — the full
-- ceiling lib/autonomous-quota.js already treats as the hard maximum, so a
-- client's day is now bounded by the platform's real limit rather than by a
-- lower per-site default sitting underneath it.
--
-- Why now: the daily loop was landing far under its budget while ~940 open
-- recommendations sat queued. The binding constraint was this column, not
-- the platform-wide gate — AUTO_REMEDIATION_GLOBAL_DAILY_CEILING is unset in
-- every environment, so globalRemainingSeed() returns Infinity and the
-- per-site value was the only thing capping the day.
--
-- Still a CEILING, not a goal (migrations 101 and 115 said the same): a site
-- with 12 eligible safe-tier items ships 12, not 100. laneBudgets() continues
-- to reserve the analyst lane first (ANALYST_MAX 20), so the most the
-- analytics lane can take on a full day is 80.
--
-- Moves both currently-tuned sites as well as the default: site 1 rides the
-- old 60 default, and site 8862 was raised to 80 by hand — both are being
-- deliberately lifted to the same 100, so neither is left behind an
-- individually-set value that no longer reflects intent.
ALTER TABLE sites ALTER COLUMN auto_remediation_daily_limit SET DEFAULT 100;

UPDATE sites SET auto_remediation_daily_limit = 100 WHERE auto_remediation_daily_limit < 100;
