-- logInternal (server/lib/errors.js) is "the one place a raw exception's
-- full detail is allowed to be written down" — but it only ever wrote that
-- detail to console.error. A customer-facing message like "Batch push/PR
-- failed... (ref: b6cfde8a)" promises a developer can look that ref up
-- later, but once the server's container logs rotate (VPS log retention,
-- a restart, a redeploy), the ref becomes permanently unresolvable — the
-- exact dead end hit auditing a 13-day-old Zunkiree Labs abandoned draft
-- (ref: b6cfde8a): the id was real, but the detail behind it was gone.
--
-- This table gives every future ref a durable, queryable home. Best-effort
-- and fire-and-forget by design (see logInternal's own insert): a failure
-- to persist the error record must never mask or throw over the original
-- error it's trying to record.
CREATE TABLE IF NOT EXISTS internal_errors (
  id TEXT PRIMARY KEY,             -- the short id already shown to customers as "ref: <id>"
  context TEXT NOT NULL,           -- the call site, e.g. 'github-ops.openPrForBranch'
  message TEXT,
  stack TEXT,
  cause_message TEXT,
  cause_stack TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookups are always "what happened at this ref id" (exact match) or
-- "what's been failing recently at this call site" — no other access
-- pattern exists, so no further indexes are needed beyond the primary key.
CREATE INDEX IF NOT EXISTS internal_errors_context_created_at_idx
  ON internal_errors (context, created_at DESC);

-- Unbounded growth from a chatty failure mode is a real risk (this table
-- has no natural cap the way drafts does) — pruned by
-- server/scripts/prune-internal-errors.js, not a DB-level TTL, so the
-- retention window is one visible, changeable number instead of buried in
-- a trigger.
COMMENT ON TABLE internal_errors IS
  'Durable store for logInternal''s "ref: <id>" codes shown in customer-facing error messages — see server/lib/errors.js. Pruned by server/scripts/prune-internal-errors.js.';
