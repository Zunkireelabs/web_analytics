-- PROPOSED, NOT APPLIED. Lets the stale-mapping repair record an attempt it could not verify (API error, timeout, truncated tree).
-- Until applied, that one audit insert fails and is only logged; the recommendation's blocked reason still says what happened.
ALTER TABLE capability_repairs DROP CONSTRAINT IF EXISTS capability_repairs_outcome_check;
ALTER TABLE capability_repairs ADD CONSTRAINT capability_repairs_outcome_check
  CHECK (outcome IN ('repaired', 'ambiguous', 'foreign-domain', 'not-found', 'requires-explicit-host-config', 'unverifiable'));
