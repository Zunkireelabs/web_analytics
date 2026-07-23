-- Real publish/approve lifecycle for drafts, replacing the draft/edited-only
-- MVP: draft -> submitted_for_approval -> approved -> implemented. There is
-- still no CMS to push content to, so "implemented" means a person put the
-- approved content live on the actual site and told the dashboard so —
-- the same real-evidence pattern hasDraftSince() already uses for the
-- Watchlist, just one step further along.
--
-- drafts_status_check itself is not touched here: every migration file
-- replays on every deploy (see run.js), so an earlier file re-narrowing the
-- constraint would break once live rows reach a status only a later
-- migration allows. 039_draft_merged_to_stage.sql owns the constraint's
-- current definition.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS implemented_at TIMESTAMPTZ;
