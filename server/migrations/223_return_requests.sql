-- Someone whose workspaces and projects were all deleted, but whose email is still an account, asks to come back. Until staff
-- approve, no sign-in code is sent. An approved request is used up by the next successful sign-in.
CREATE TABLE IF NOT EXISTS return_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by INTEGER,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS return_requests_user_idx ON return_requests (user_id, created_at DESC);
