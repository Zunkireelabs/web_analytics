-- A project's OWN Google access, granted by whoever clicked "Connect with Google".
--
-- Until now every project read Search Console and Analytics through ONE shared
-- Google account (GOOGLE_OAUTH_REFRESH_TOKEN), which had to be added as a user on
-- each client's property by hand, and which could therefore see — and offer in a
-- picker — every client's properties. With this table a project can instead hold the
-- refresh token of the Google account that connected it: it reads only what that
-- account can reach, and the picker can only ever show that account's properties.
--
--   refresh_token_enc  the token, AES-256-GCM encrypted (server/lib/secret-box.js,
--                      key from SECRETS_ENCRYPTION_KEY). Never stored in the clear.
--                      A SEPARATE table on purpose: sites is read with SELECT * in many
--                      places and serialised to browsers; a credential must never
--                      ride along in a row like that, encrypted or not.
--   google_email       which Google account it is, for showing "Connected as ..." and
--                      for the audit trail.
--   scopes             what was actually granted (Google can grant less than asked).
--
-- One connection per project; reconnecting replaces it. Removing the site removes it.
-- Additive and idempotent, like every file here.

CREATE TABLE IF NOT EXISTS project_google_connections (
  site_id            INT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  google_email       TEXT,
  refresh_token_enc  TEXT NOT NULL,
  scopes             TEXT,
  connected_by       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
