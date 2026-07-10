-- Persist the single monthly-report Google Doc id per site.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS monthly_doc_id TEXT;

-- Track the first day of the last month written (idempotency across cron + restarts).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS monthly_last_done DATE;
