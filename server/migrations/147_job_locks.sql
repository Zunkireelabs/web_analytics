-- A lease-based lock, not a Postgres advisory lock: DATABASE_URL runs
-- through Supavisor in transaction-pooling mode (port 6543), where a session
-- advisory lock can be granted on one physical backend and checked on a
-- different one on the very next statement, and a transaction-scoped
-- advisory lock would have to hold one pooled connection open for a run that
-- can last hours (this table's own reason for existing) — starving the
-- pooler for every other query on this database, migrations included. A row
-- with an expiry survives both problems: it needs no held connection or
-- transaction, and a crashed holder self-clears on its own without a second
-- process ever having to detect the crash.
--
-- Built to stop the concrete failure that motivated it: 2026-09-08, the
-- laptop dev server (no DISABLE_CRON) and the VPS staging container both ran
-- server/cron.js's 07:00 job against the SAME site, SAME database, SAME
-- GitHub App token, minutes apart — see auto_remediation_runs for site 1
-- firing at 01:38, 01:43, 02:03 and 02:05 the same morning. Doubling the
-- GitHub API calls a single run makes is what exhausted the token and left
-- the day's batch PR unopened (see batch-pr-recovery.js's own history for
-- what that cost). A lock keyed per (site, job) turns "two schedulers exist"
-- from a silent API-budget race into the second one finding the lock held
-- and skipping its turn, cleanly, every time.
CREATE TABLE job_locks (
  job_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Locks are checked far more often than they're written (a heartbeat on
-- every long run), so make the read path — WHERE job_key = $1 AND
-- expires_at > now() — free; job_key alone (the primary key) already covers
-- that, this only speeds the janitorial "list anything expired" query if one
-- is ever added.
CREATE INDEX idx_job_locks_expires_at ON job_locks (expires_at);
