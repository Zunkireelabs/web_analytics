-- Structured "render mode unclear" info (reason/confidence/suggestedMode)
-- from render-inspector.js's inspectRenderMode, persisted alongside
-- apply_error so the "Use Visible"/"Use Schema-only" resolution prompt in
-- DraftModal survives a modal close/reopen or page reload instead of only
-- existing in transient React state tied to the API response that produced
-- it. Nullable/purely additive; cleared to NULL wherever apply_error already
-- is (approved -> branch_pushed/merged_to_stage/pr_opened).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS render_mode_confirm JSONB;
