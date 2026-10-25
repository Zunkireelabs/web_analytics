-- Workspace layer: workspace -> projects (sites), with a real membership table.
--
-- Until now the tenancy model was flat: one site == one tenant, and one user
-- row belonged to exactly one site (011_users_and_site_profile.sql). That
-- cannot express "Zunkiree Labs is a workspace with its own team and its own
-- website as ONE project", or "an agency person belongs to two clients".
--
--   workspaces            the account/company (Notion-style workspace)
--   sites.workspace_id    a site is a PROJECT inside exactly one workspace
--   workspace_members     who can see a workspace, and in what role
--
-- sites stays the unit every existing route scopes by (req.siteId), so no
-- data table or route changes: the workspace layer only decides WHICH sites a
-- user may switch into. users.site_id stays as the user's home site.
--
-- Additive only: nothing is dropped or rewritten. Every statement is
-- idempotent and every data statement carries a guard, because the migration
-- tests treat unguarded UPDATE/DELETE as a defect.

CREATE TABLE IF NOT EXISTS workspaces (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  -- Which site this workspace was created from by the backfill below. Makes
  -- the backfill converge (one workspace per legacy site, never two) and
  -- records where the workspace came from. NULL for workspaces created later.
  legacy_site_id INT UNIQUE REFERENCES sites(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sites ADD COLUMN IF NOT EXISTS workspace_id INT REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS idx_sites_workspace ON sites (workspace_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id);

-- Backfill 1: one workspace per existing site that has none yet. A site that
-- already has a workspace_id, or whose workspace was already created on a
-- previous run, is skipped.
INSERT INTO workspaces (name, legacy_site_id)
SELECT COALESCE(NULLIF(trim(s.name), ''), 'Workspace ' || s.id), s.id
FROM sites s
WHERE s.workspace_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.legacy_site_id = s.id);

-- Backfill 2: attach each unattached site to the workspace made for it.
UPDATE sites
SET workspace_id = w.id
FROM workspaces w
WHERE w.legacy_site_id = sites.id
  AND sites.workspace_id IS NULL;

-- Backfill 3: every existing user becomes a member of the workspace their home
-- site now belongs to. tenant_admin / platform_admin -> owner (today each site
-- has a single login, so that person is the owner); tenant_member -> member.
-- ON CONFLICT keeps re-runs, and any membership added later, untouched.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT s.workspace_id, u.id,
       CASE WHEN u.role IN ('tenant_admin', 'platform_admin') THEN 'owner' ELSE 'member' END
FROM users u
JOIN sites s ON s.id = u.site_id
WHERE s.workspace_id IS NOT NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;
