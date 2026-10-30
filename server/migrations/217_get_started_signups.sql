-- People who started a free trial from the public /get-started page.
--
-- They are prospects trying the product, not clients, so there is no approval step: they type an email, get a
-- 6-digit code (the codes themselves live in login_codes, migration 206), and once the code is right they
-- become a real login. This table is the record of who started that way, kept apart from signup_requests (the
-- reviewed sign-up form) so the two are never mixed up and staff can see trial starts on their own.
-- One row per address; asking again only refreshes it.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS get_started_signups (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT        NOT NULL UNIQUE,
  via         TEXT        NOT NULL DEFAULT 'email' CHECK (via IN ('email', 'google')),
  user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
