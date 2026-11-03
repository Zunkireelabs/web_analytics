-- Sign-up recovery (SRANK-42): one reminder email to a person who stopped part-way through /get-started, a one-person
-- link that signs them back in, and the staff settings that decide how long things are kept (migration 220 keeps the answers).
--
-- Additive and idempotent, like every file here; no data statements. The settings row is written by the app on first read.
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS reminder_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS reminders_muted  BOOLEAN NOT NULL DEFAULT false;

-- The resume link in the reminder. Only a hash of the token is kept, so a database read cannot sign anyone in.
CREATE TABLE IF NOT EXISTS signup_resume_links (
  id         BIGSERIAL   PRIMARY KEY,
  token_hash TEXT        NOT NULL UNIQUE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_resume_links_user_idx ON signup_resume_links (user_id, created_at DESC);

-- One row of staff settings (the CHECK keeps it to one).
CREATE TABLE IF NOT EXISTS signup_recovery_settings (
  id                BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  remind_after_days INTEGER     NOT NULL DEFAULT 7  CHECK (remind_after_days BETWEEN 1 AND 60),
  link_days         INTEGER     NOT NULL DEFAULT 2  CHECK (link_days BETWEEN 1 AND 60),
  keep_days         INTEGER     NOT NULL DEFAULT 30 CHECK (keep_days BETWEEN 1 AND 365),
  confirmed_only    BOOLEAN     NOT NULL DEFAULT true,
  purge_day         INTEGER     NOT NULL DEFAULT 30 CHECK (purge_day BETWEEN 1 AND 365),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
