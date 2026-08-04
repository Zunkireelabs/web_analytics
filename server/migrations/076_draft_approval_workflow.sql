-- Phase 3 approval workflow — who rejected/requested revision and why,
-- mirroring approved_by's pattern (024). revision_history is an
-- append-only JSONB array (see requestDraftRevision in store/drafts.js)
-- so a draft that goes through multiple review rounds keeps every past
-- reviewer/reason/timestamp, not just the latest.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS abandoned_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_requested_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_reason TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Investigation-level approvals (recommendations that don't produce a
-- content draft) live in approval_history in the separate data-analyst-
-- agent Postgres database, alongside the investigations they reference —
-- see data-analyst-agent/app/db/migrations/versions/0031_approval_history.py.
-- Nothing to add here for that.
