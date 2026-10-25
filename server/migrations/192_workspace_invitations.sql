-- Workspace invitations: an invitation can now carry the workspace and the role
-- the invitee should get in it (migration 191 introduced workspaces and
-- workspace_members). The existing columns are untouched, so every invitation
-- already issued keeps working exactly as before.
--
-- site_id stays NOT NULL: it is the project the invitee's account is created
-- under as their home site. workspace_id/workspace_role are NULL for the old
-- per-site invitations.
--
-- Additive and idempotent; no data statements.

ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS workspace_role TEXT;

ALTER TABLE user_invitations DROP CONSTRAINT IF EXISTS user_invitations_workspace_role_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_workspace_role_check
  CHECK (workspace_role IS NULL OR workspace_role IN ('owner', 'admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_user_invitations_workspace ON user_invitations (workspace_id);
