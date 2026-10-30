-- AI visibility page: a person can tick the prompts they are missing and ship them,
-- now or on the daily run. These three columns carry that request on the prompt
-- itself (additive, all NULL by default, so every existing row is untouched).
--   ship_requested_at  set when the prompt is ticked and shipped (now or queued for the daily run)
--   ship_draft_id      the Action Center draft that covers it, once generated
--   ship_error         why the last generation attempt failed, so the page can say so
ALTER TABLE ai_tracked_prompts
  ADD COLUMN IF NOT EXISTS ship_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ship_draft_id INT REFERENCES drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ship_error TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_tracked_prompts_ship_pending
  ON ai_tracked_prompts (site_id)
  WHERE ship_requested_at IS NOT NULL AND ship_draft_id IS NULL AND active = true;
