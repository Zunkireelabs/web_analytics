-- Prove the sign-up email belongs to the person BEFORE a login exists for it.
--
-- Until now approving a sign-up request created the login straight away, for whatever
-- address (and password) the form was filled in with. Nobody had shown they own that
-- inbox, so someone could request an account for another person's email, choose the
-- password themselves, and be signed in as that address the moment staff approved it.
--
-- Now approval only marks the request approved and emails a one-time link. The login is
-- created when the link is used, by whoever can read that inbox.
--
--   verify_token_hash  SHA-256 of the one-time token (the token itself is never stored,
--                      same rule as invitations and password resets)
--   verify_expires_at  the link stops working after seven days
--   verified_at        when the link was used (set once; also what makes it single-use)
--   user_id            the login that was created at that moment
--
-- Additive and idempotent, like every file here; no data statements.

ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS verify_token_hash TEXT;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS verify_expires_at TIMESTAMPTZ;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_signup_requests_verify_hash ON signup_requests (verify_token_hash) WHERE verify_token_hash IS NOT NULL;
