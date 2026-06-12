-- Track the start date of the last week written to the report doc, so the
-- weekly run is idempotent (cron + startup catch-up never insert a week twice).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS weekly_last_done DATE;
