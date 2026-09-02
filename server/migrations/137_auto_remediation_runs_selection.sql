-- Adds the daily-queue selection reasoning to the per-run log (migration
-- 136) and a quarantine counter, so "why was X selected instead of Y" and
-- "how many items were quarantined this run" are answerable from the row
-- itself rather than a scrolled-away console log.
--
-- `selection` holds daily-queue.js's report: eligible/selected/skipped
-- counts, per-tier and per-generator distribution, the top-ranked items with
-- their score factors, why each deferred item lost, and which generators (if
-- any) were quarantined this run and why. See auto-remediation.js's `finish`.
ALTER TABLE auto_remediation_runs ADD COLUMN IF NOT EXISTS quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_remediation_runs ADD COLUMN IF NOT EXISTS selection JSONB;
