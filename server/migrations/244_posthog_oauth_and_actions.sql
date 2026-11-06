-- PostHog "Connect with PostHog" (OAuth) and the Overview's "What visitors did" data.
--
-- 1) project_posthog_connections can now hold an OAuth grant instead of a pasted personal API key.
--    - auth_method says which: 'key' (migration 239, unchanged) or 'oauth'.
--    - An OAuth connection exists in two steps: the person signs in on PostHog (we hold a refresh token), THEN picks which
--      PostHog project is this website. Between the two there is a real row with no project yet, so project_id and
--      api_key_enc are no longer NOT NULL. A CHECK keeps that honest: a 'key' row must still have both, an 'oauth' row
--      must have a refresh token. The daily job only reads rows that HAVE a project (see listPosthogConnectedSites).
--    - Tokens are stored ENCRYPTED (lib/secret-box.js), exactly like the Google refresh token and the pasted key. The access
--      token is cached here (with its expiry) so the web process, the nightly job and the backfill share one fresh token
--      instead of each refreshing and racing a rotated refresh token.
--    - connected_email / project_name are display-only ("Connected as ...", the project's name).
--
-- 2) posthog_daily.top_actions: the day's most-used clicks and form steps, JSONB like drop_offs and for the same reason
--    (a short read-whole top-N per day, never joined or filtered).
--
-- Additive and idempotent, like every file here; no data statements.
ALTER TABLE project_posthog_connections ALTER COLUMN project_id   DROP NOT NULL;
ALTER TABLE project_posthog_connections ALTER COLUMN api_key_enc  DROP NOT NULL;

ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS auth_method        TEXT NOT NULL DEFAULT 'key';
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS refresh_token_enc  TEXT;
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS access_token_enc   TEXT;
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS access_expires_at  TIMESTAMPTZ;
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS scopes             TEXT;
-- The client_id (a URL, see integrations/posthog-connect.js) the grant was issued to. A refresh must present the SAME one, and
-- the nightly job has no web request to rebuild it from, so it is stored with the grant.
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS oauth_client_id    TEXT;
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS connected_email    TEXT;
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS project_name       TEXT;
-- Which PostHog project's data is in posthog_daily for this site: '<host>|<project id>'. When the chosen project or host changes
-- the old project's days are cleared (they would otherwise be shown, and mixed, as if they belonged to the new one). Kept across
-- a re-sign-in so reconnecting the SAME account and project does not throw history away.
ALTER TABLE project_posthog_connections ADD COLUMN IF NOT EXISTS data_key           TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_posthog_auth_method_check') THEN
    ALTER TABLE project_posthog_connections
      ADD CONSTRAINT project_posthog_auth_method_check CHECK (auth_method IN ('key', 'oauth'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_posthog_credential_check') THEN
    ALTER TABLE project_posthog_connections
      ADD CONSTRAINT project_posthog_credential_check CHECK (
        (auth_method = 'key'   AND project_id IS NOT NULL AND api_key_enc IS NOT NULL)
        OR (auth_method = 'oauth' AND refresh_token_enc IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE posthog_daily ADD COLUMN IF NOT EXISTS top_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
