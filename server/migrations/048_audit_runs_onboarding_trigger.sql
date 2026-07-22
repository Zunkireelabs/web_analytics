-- Full Site Audit now also runs automatically during client onboarding
-- (server/routes/clients.js's runBaselineSequence), not just the manual
-- "Run Full Audit" button — audit_runs.triggered_by (migration 043) needs a
-- third real value to record that honestly, rather than misreporting an
-- onboarding-triggered run as 'manual'.
ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_triggered_by_check;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_triggered_by_check
  CHECK (triggered_by IN ('manual', 'scheduled', 'onboarding'));
