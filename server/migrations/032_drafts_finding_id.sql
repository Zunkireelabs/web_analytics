-- Real join key back to the finding a draft was generated from — nullable,
-- since only new generate calls populate it (legacy drafts, and drafts from
-- generators with no addressable finding, stay NULL and keep relying on the
-- existing hasDraftSince() correlation heuristic). This is what lets the
-- Verify stage (migration 033) tie a specific implemented draft back to the
-- exact finding/page it was meant to fix, instead of guessing by
-- agent+generator+timestamp.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS finding_id TEXT;
