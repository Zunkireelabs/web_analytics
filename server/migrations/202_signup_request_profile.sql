-- A standard sign-up: who the person is, not just which company.
--
-- The request form now asks for the person's full name, their role (one of a short list, or
-- their own words under "Other"), how they heard about SuperRank (optional), and records that
-- they accepted the Terms and Privacy policy. Staff see all of it when they approve.
--
--   full_name         copied to users.display_name when the email is confirmed
--   role              what they do, as chosen or typed
--   heard_from        how they found SuperRank, as chosen or typed (optional)
--   terms_accepted_at when the box was ticked
--
-- Additive and idempotent, like every file here; no data statements. Older requests keep NULLs.

ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS heard_from TEXT;
ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
