-- Extends the approve lifecycle (migration 024) with a real PR step: approved
-- -> pr_opened -> implemented. "Implemented" now requires real evidence
-- (pr_state = 'merged', confirmed by a real GitHub API read via
-- server/github/client.js) for any draft that went through an implementer,
-- the same real-evidence discipline hasDraftSince() already uses for the
-- Watchlist — see the updated markDraftImplemented in server/store/drafts.js.
-- The legacy manual path (approved -> implemented with no PR ever attempted)
-- stays intact for generator types with no implementer wired yet.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN ('draft', 'edited', 'submitted_for_approval', 'approved', 'pr_opened', 'implemented'));

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS branch_name TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pr_url TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pr_number INT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pr_state TEXT;         -- 'open' | 'closed' | 'merged'
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS implementer_id TEXT;   -- 'frontend' | 'backend' — audit trail of which implementer applied this
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS apply_error TEXT;      -- last apply() failure reason, cleared on success
