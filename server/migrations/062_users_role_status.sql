-- Platform Administration, Phase 0 (see PLATFORM-ADMIN-DESIGN.md §G.3, §K).
-- Adds the human-role dimension to users, kept fully independent of MCP
-- token permission_level (api_tokens.permission_level) — see §C.3, no code
-- path may infer one from the other.
--
-- Default 'tenant_admin' is deliberately correct for every row that exists
-- today except COMPANY_SITE_ID's own users, which the backfill step below
-- (server/migrations/run.js, run after this file) promotes to
-- 'platform_admin'. This mirrors 055's "default is already correct, no
-- backfill needed for the general case" reasoning — only the internal-site
-- carve-out needs an explicit UPDATE, and that UPDATE needs process.env.
-- COMPANY_SITE_ID, which a static .sql file has no access to.
--
-- platform_support/tenant_viewer are included in the CHECK now even though
-- no route enforces a distinction from platform_admin/tenant_member yet
-- (§C.1's "reserved only" rationale) — cheap to reserve now, avoids a
-- later migration just to widen the constraint.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tenant_admin';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('platform_admin', 'platform_support', 'tenant_admin', 'tenant_member', 'tenant_viewer'));

-- 'active' is correct for every existing row — nobody has ever been
-- disabled because the capability didn't exist before this column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'disabled'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
