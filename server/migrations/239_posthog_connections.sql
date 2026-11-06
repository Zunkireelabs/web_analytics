-- Optional PostHog connection, per project.
--
-- OPTIONAL BY DESIGN. PostHog answers a question GA4 cannot — where people drop out of a funnel, what one person
-- actually did, whether they came back — but only a client who already uses PostHog has it. A project with no row
-- here is complete and correct; nothing about the platform degrades, and no onboarding step blocks on it.
--
-- The API key is stored ENCRYPTED (lib/secret-box.js, SECRETS_ENCRYPTION_KEY), exactly as each project's Google
-- refresh token already is in project_google_connections — it is a client credential that can read their product
-- analytics, so it must never sit in plaintext, in a log, or in an error message.
--
-- `host` exists because PostHog is self-hostable: a client on EU cloud or their own instance is not reachable at the
-- US default, and guessing would silently read nothing. Defaulted to the US cloud host, which is what most use.
--
-- `status` mirrors the Google connection's own convention, so a key that has been revoked shows as a real, named
-- problem on the connection screen instead of silently returning zeros for weeks.
--
-- Additive and idempotent, like every file here; no data statements — no project is connected by this migration.
CREATE TABLE IF NOT EXISTS project_posthog_connections (
  site_id       INTEGER     PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  project_id    TEXT        NOT NULL,
  host          TEXT        NOT NULL DEFAULT 'https://us.posthog.com',
  api_key_enc   TEXT        NOT NULL,
  connected_by  INTEGER,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error')),
  status_error  TEXT,
  status_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_posthog_connections ENABLE ROW LEVEL SECURITY;
