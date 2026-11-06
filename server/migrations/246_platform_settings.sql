-- SRANK-47: platform-wide settings a platform admin can change from the Platform page instead of by editing server
-- environment variables, plus an append-only history of who changed what and when.
--
-- platform_settings: one row per setting key (first user: 'master_agent_mode' = "off" | "shadow" | "on"). `value` is JSONB so a
--   setting can be a string today and richer later without a migration. No secrets are ever stored here.
-- platform_setting_changes: append-only. Written in the same statement as the setting it describes (see lib/platform-settings.js),
--   and also used for switches whose current value lives elsewhere (key 'site:<id>:autonomy' records who turned a project's
--   auto-fixes on or off; the value itself stays in sites.auto_remediation_enabled so the existing staff Controls dialog and this
--   page can never disagree).
--
-- Additive and idempotent. No data statements: nothing changes for any project when this is applied, and with no row the Master
-- Agent mode resolves to 'off'.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_setting_changes (
  id               BIGSERIAL   PRIMARY KEY,
  key              TEXT        NOT NULL,
  from_value       JSONB,
  to_value         JSONB,
  changed_by       INTEGER,
  changed_by_email TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_setting_changes_key_idx ON platform_setting_changes (key, changed_at DESC);

-- Same posture as every recent table (225, 239, 240): RLS on, and the app reads and writes through its own role.
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_setting_changes ENABLE ROW LEVEL SECURITY;
