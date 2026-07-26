-- Platform Administration, Phase 0 (see PLATFORM-ADMIN-DESIGN.md §D, §G.3).
-- Tenant lifecycle status. Default 'active' is correct for every existing
-- row unconditionally — no backfill needed, unlike users.role.
--
-- Enforcement (requireAuth/requireMcpToken/oauth-provider.js checks,
-- listConnectedSites() cron filter) is Phase 3, not this migration —
-- this file only adds the column so later phases have somewhere to write.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_status_check;
ALTER TABLE sites ADD CONSTRAINT sites_status_check
  CHECK (status IN ('active', 'suspended', 'soft_deleted'));

ALTER TABLE sites ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
