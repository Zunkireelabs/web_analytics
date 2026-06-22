-- Persist the single daily-report Google Doc id per site.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS daily_doc_id TEXT;

-- Track when each day's entry was written to the daily doc (idempotency).
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS daily_doc_done TIMESTAMPTZ;
