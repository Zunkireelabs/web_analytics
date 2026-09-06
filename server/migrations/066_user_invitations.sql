-- Platform Administration, Phase 4 (PLATFORM-ADMIN-DESIGN.md §E, §K). Same
-- "separate lifecycle table promoted into the real thing on acceptance"
-- pattern as signup_requests (037) — an invitation is never a loginable
-- account until POST /invitations/:token/accept succeeds.
--
-- site_id/role are exactly what the inviting route derives server-side from
-- the *inviter's own identity* (§E) — never trusted from a request body —
-- and are simply carried here until acceptance creates the real users row
-- with these same two values. role's CHECK mirrors users_role_check (062)
-- so an invitation can never be created for a role users.role itself would
-- reject at insert time.
--
-- site_id CASCADEs (unlike signup_requests.created_site_id's SET NULL):
-- an invitation is tenant-operational data tied to a specific site, same
-- category as growth_targets/integration_health (064) — safe to remove
-- with the tenant, nothing worth preserving once the tenant itself is gone.
CREATE TABLE IF NOT EXISTS user_invitations (
  id          SERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('platform_admin', 'platform_support', 'tenant_admin', 'tenant_member', 'tenant_viewer')),
  invited_by  INT REFERENCES users(id) ON DELETE SET NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations (token_hash) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_invitations_site ON user_invitations (site_id);
