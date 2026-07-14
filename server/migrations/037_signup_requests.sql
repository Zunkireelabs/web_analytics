-- Public "Request Access" signup requests — a real prospective-client
-- submission, but never a loginable account until staff reviews and
-- approves it (server/routes/clients.js's new approve route). Deliberately
-- a standalone table, not a users/sites schema change: a request is not a
-- real account until approved, same "separate lifecycle table promoted
-- into the real thing on approval" pattern as drafts (migration 014/024).
--
-- password_hash is a real bcrypt hash from the moment of submission (see
-- the public POST /signup-requests route) — the plaintext password is
-- never persisted anywhere, same policy the existing POST /internal/clients
-- route already follows for staff-created accounts.
CREATE TABLE IF NOT EXISTS signup_requests (
  id                SERIAL PRIMARY KEY,
  company_name      TEXT NOT NULL,
  website_domain    TEXT,
  contact_email     TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  message           TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_site_id   INT REFERENCES sites(id),
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests (status, created_at DESC);
