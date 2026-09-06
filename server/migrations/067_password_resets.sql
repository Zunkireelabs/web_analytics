-- Platform Administration, Phase 4 (PLATFORM-ADMIN-DESIGN.md §E, §K).
-- Admin-triggered password reset — nothing like this existed before this
-- migration (only self-service "change with current password," which
-- requires already knowing the old one). Same shape and same atomic
-- single-use consumption pattern as user_invitations above: token_hash
-- only, never the raw token; a single `UPDATE ... WHERE used_at IS NULL
-- AND expires_at > now() RETURNING ...` both validates and consumes.
--
-- user_id CASCADEs — a password reset row has no meaning once the user
-- it's for is gone (and today that only happens via a real users DELETE,
-- which doesn't exist yet per §E's explicit deferral of hard user-delete).
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets (token_hash) WHERE used_at IS NULL;
