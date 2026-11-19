-- The result of the last site-readiness run (readiness/run.js): what the platform learned about the project and, page by page, whether every
-- marker is placed or listed with a stated reason. Plain ADD COLUMN, no UPDATE (see migration 256's note).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS readiness_result JSONB;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS readiness_at     TIMESTAMPTZ;
