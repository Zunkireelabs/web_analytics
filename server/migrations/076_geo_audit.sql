-- Track when the GEO audit generator was last run for each site,
-- so the weekly recurring check can skip sites that already ran
-- this week (idempotent across cron + startup catch-up + restarts).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS geo_audit_last_done DATE;