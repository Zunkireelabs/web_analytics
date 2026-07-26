-- Removes the reserved-but-never-enforced role values (platform_support,
-- tenant_viewer) added by 062/066. No route ever distinguished them from
-- platform_admin/tenant_member, and a live check confirmed no user or
-- pending invitation holds either value — safe to drop with no backfill.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('platform_admin', 'tenant_admin', 'tenant_member'));

ALTER TABLE user_invitations DROP CONSTRAINT user_invitations_role_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_role_check
  CHECK (role IN ('platform_admin', 'tenant_admin', 'tenant_member'));
