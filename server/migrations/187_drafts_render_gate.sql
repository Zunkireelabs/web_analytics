-- Why a draft was held (or would have been), visible to the reviewer.
-- The render gate's deviations — expected vs measured heading scale, gaps,
-- line length — are structured evidence a person reading a held draft needs.
-- Additive and nullable: every existing draft simply has none.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS render_gate JSONB;
