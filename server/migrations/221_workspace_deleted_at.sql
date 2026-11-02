-- A workspace a platform admin removed. Its projects are soft-deleted (sites.status = 'soft_deleted') and its people are
-- taken out of it; this column keeps the workspace row so nothing that points at it breaks, and hides it from the lists.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
