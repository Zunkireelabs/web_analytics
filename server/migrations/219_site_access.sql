-- Who may use a project, and for how long. Added for the free-trial approval flow (see server/store/access.js).
--
-- A project made on /get-started starts 'pending': its owner sees the dashboard behind a lock until staff approve it.
-- Staff then approve it as a 15-day 'demo' (it becomes 'ended' on access_ends_at, and the Google and GitHub connections
-- are removed) or as a 'client' (no end date). 'rejected' keeps the lock for good.
--
-- Every project that exists today, and every project made any other way, stays 'client', so nothing about an existing
-- account changes. Additive and idempotent, like every file here; no data statements.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'client';
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_access_state_check;
ALTER TABLE sites ADD CONSTRAINT sites_access_state_check
  CHECK (access_state IN ('pending', 'demo', 'ended', 'client', 'rejected'));

-- Where the project came from ('get-started'), so the approval list shows only what needs a decision.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_source TEXT;
-- When the person pressed "Request access" (a 'pending' project with no request yet is not in staff's list).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_requested_at TIMESTAMPTZ;
-- A demo's last moment. Null for everything else.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_ends_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_ended_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_decided_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- Staff can let a demo skip connecting GitHub (a demo with nothing connected has nothing to disconnect).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS access_github_optional BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sites_access_state ON sites (access_state) WHERE access_state <> 'client';
