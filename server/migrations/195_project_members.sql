-- Project-level access: a person can be given access to ONE project (or several)
-- without belonging to the workspace that holds it.
--
--   workspace_members (191)  the whole workspace: every project in it, now and later
--   project_members   (this) specific projects only; nothing else in the workspace is visible
--
-- Roles at project level are 'admin' (manage that project: goal, API tokens, who
-- has access to it) and 'member' (read-only: see everything in it, change
-- nothing). 'owner' only exists on a workspace.
--
-- Invitations can carry a project scope too, so someone with no account yet gets
-- access to just those projects once they accept (their home site is the first
-- of them). project_site_ids is NULL for every older, whole-workspace invitation.
--
-- Additive and idempotent: this directory re-applies every file on every deploy,
-- so schema statements use IF NOT EXISTS / DROP-then-ADD, with no data statements.

CREATE TABLE IF NOT EXISTS project_members (
  site_id    INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id)
);

ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check CHECK (role IN ('admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members (user_id);

ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS project_site_ids INT[];
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS project_role TEXT;

ALTER TABLE user_invitations DROP CONSTRAINT IF EXISTS user_invitations_project_role_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_project_role_check
  CHECK (project_role IS NULL OR project_role IN ('admin', 'member'));
