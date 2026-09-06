-- Per-site email recipient. Without this, every client's daily report would
-- be sent to the same global REPORT_EMAIL_TO, regardless of which client's
-- site generated it. Nullable: sites without a value fall back to the global
-- env var (server/report/email.js), so the original env-configured site
-- keeps working without a backfill.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS report_email_to TEXT;
