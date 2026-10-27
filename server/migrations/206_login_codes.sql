-- Sign in with an emailed code.
--
-- "Email me a sign-in code instead" on the sign-in page sends a 6-digit code that works once and
-- expires in 10 minutes. Only a hash of the code is stored, never the code. A code is spent after
-- 5 wrong tries, and the rows also give the rate limit (how many were sent to an address lately).
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS login_codes (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_created_idx ON login_codes (email, created_at DESC);
