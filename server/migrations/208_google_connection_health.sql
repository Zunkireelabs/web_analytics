-- Health of each project's OWN Google connection, kept per project so one client's
-- revoked or expired sign-in never shows up on, or switches off, anyone else's.
--   ok         usable
--   expired    Google refused the refresh token (revoked, expired, access removed)
--   unreadable the stored token cannot be decrypted here (key changed or missing)
-- Anything but 'ok' means: reconnect before reading again. Additive and idempotent.
ALTER TABLE project_google_connections ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE project_google_connections ADD COLUMN IF NOT EXISTS status_error TEXT;
ALTER TABLE project_google_connections ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
