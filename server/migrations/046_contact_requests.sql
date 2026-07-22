-- Public "Contact Us" leads — a lightweight inquiry, never an account
-- request. Deliberately separate from signup_requests (migration 037):
-- a contact lead has no password and never becomes a real sites/users row,
-- it just moves through new -> contacted -> closed as staff follow up.
CREATE TABLE IF NOT EXISTS contact_requests (
  id              SERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  website_domain  TEXT,
  contact_email   TEXT NOT NULL,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT 'new', -- new | contacted | closed
  contacted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_status ON contact_requests (status, created_at DESC);
