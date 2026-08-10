-- Cooperative cancellation for Full Site Audit (agents/lib/bulk-audit.js) —
-- a run can take from seconds to well over an hour (see migration 043's own
-- comment, and reapStaleAuditRuns' real 22-hour-stuck-run incident), and
-- until now there was no way to stop one early once it looked like it was
-- taking too long, short of waiting for reapStaleAuditRuns' 2-hour timeout
-- or a server restart. cancel_requested is a flag the running process
-- checks between agent/chunk boundaries (see runFullSiteAudit) — the
-- process can't be interrupted mid-flight from outside, only asked to stop
-- at its next checkpoint, same "cooperative, not forcible" cancellation
-- every other long-running loop in this app already uses.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_status_check;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'partial', 'cancelled'));
