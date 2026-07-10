-- Persist the single AI Executive Report Google Doc id per site, and track
-- the start date of the last week written, mirroring weekly_doc_id/
-- weekly_last_done exactly (002_weekly_doc.sql, 003_weekly_last_done.sql) —
-- same idempotency pattern, separate doc from the weekly analytics report.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS executive_doc_id TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS executive_last_done DATE;
