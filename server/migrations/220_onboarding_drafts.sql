-- The /get-started answers, kept on the server as the person goes (migration 218 keeps the FINISHED answers with the
-- project). One draft per person: they can leave, and carry on tomorrow or from another device. Deleted when they finish.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  user_id    INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  step       TEXT,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
