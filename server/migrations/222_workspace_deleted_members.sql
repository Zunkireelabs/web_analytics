-- Who was in a workspace when a platform admin or its owner removed it, so support can put them back if it is restored.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_members JSONB;
