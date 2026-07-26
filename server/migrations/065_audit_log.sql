-- Platform Administration, Phase 0 (see PLATFORM-ADMIN-DESIGN.md §G.3).
-- No route writes to this table yet (that starts in Phase 2) — this
-- migration only creates the table so audit logging has somewhere to land
-- once wired up.
--
-- actor_site_id/tenant_site_id use ON DELETE SET NULL, never CASCADE —
-- the dominant FK convention elsewhere in this repo (sites cascades to its
-- own data) would be wrong here: it would let hard-deleting a tenant
-- delete its own audit trail, including the very log entry recording the
-- deletion. denormalized actor_email/tenant_name keep the row meaningful
-- after the referenced sites/users rows are gone.
CREATE TABLE IF NOT EXISTS audit_log (
  id             SERIAL PRIMARY KEY,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('platform_user', 'tenant_user', 'mcp_token', 'system')),
  actor_id       INTEGER,
  actor_role     TEXT,
  actor_site_id  INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  actor_email    TEXT,
  tenant_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  tenant_name    TEXT,
  ip_address     INET,
  user_agent     TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  metadata       JSONB,
  success        BOOLEAN NOT NULL,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matches Module 7's stated filter axes (actor, tenant, action type, date
-- range) so the read view Phase 7 builds isn't a sequential scan from day one.
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON audit_log (tenant_site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created ON audit_log (actor_site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log (action, created_at DESC);

-- Records must be append-only, even from platform_admin, even from a
-- future code change that adds an UPDATE/DELETE by mistake — no route,
-- tool, or admin capability in this design ever issues one (§G.3). Belt-
-- and-suspenders at the DB level: revoke on CURRENT_USER, i.e. whatever
-- role this migration itself is running as, which is the same pooled role
-- server/db.js's app connection uses (see server/migrations/run.js).
--
-- Caveat, stated explicitly rather than silently assumed: in Postgres the
-- table OWNER always bypasses GRANT/REVOKE checks on objects it owns,
-- regardless of what's revoked. Since this migration's role is also the
-- role that just CREATEd the table (the common single-role Neon setup),
-- it is very likely still the owner and this REVOKE is a no-op for that
-- role today. It's included anyway because it's free, and it becomes a
-- real guarantee the moment the app is split to a least-privilege
-- non-owner role — which is the only configuration where a DB-level
-- REVOKE was ever going to add anything beyond "no code path calls this."
DO $$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE ON audit_log FROM %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping audit_log REVOKE: % lacks privilege to revoke its own grants.', current_user;
END $$;
