-- Persist the single weekly-report Google Doc id per site, so the agent
-- updates the same doc every week instead of creating a new one.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS weekly_doc_id TEXT;
