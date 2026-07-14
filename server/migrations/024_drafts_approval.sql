-- Real publish/approve lifecycle for drafts, replacing the draft/edited-only
-- MVP: draft -> submitted_for_approval -> approved -> implemented. There is
-- still no CMS to push content to, so "implemented" means a person put the
-- approved content live on the actual site and told the dashboard so —
-- the same real-evidence pattern hasDraftSince() already uses for the
-- Watchlist, just one step further along.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN ('draft', 'edited', 'submitted_for_approval', 'approved', 'implemented'));

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS implemented_at TIMESTAMPTZ;
