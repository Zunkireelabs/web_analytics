-- Evidence columns for the 'abandoned' status added to drafts_status_check
-- in 039 — when a draft got abandoned and why (e.g. 'pr_closed_without_merge',
-- 'superseded_by_site_wide_llms_txt'), mirroring implemented_at's pattern.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS abandoned_reason TEXT;
