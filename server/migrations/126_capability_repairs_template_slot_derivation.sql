-- Extends capability_repairs (migration 124) for the NEW "capability-repair"
-- Design Agent mode (server/design-agent/python/design_task.py) — the
-- mechanism that repairs a true 'architectural-gap' (no template slot for a
-- generator, no sibling route to clone) by deriving and adding a new data
-- field + template rendering slot, then validating with the client's own
-- build. Distinct from the two existing capability_type values, which cover
-- an EARLIER, different mechanism (url_file_map page/new-content-target
-- discovery) — this one adds a new type rather than overloading either.
--
-- Also adds 'failed' to outcome: the three existing values (ambiguous,
-- foreign-domain, not-found) all describe why THAT earlier discovery
-- mechanism declined to guess: none of them mean "a real repair attempt ran
-- and did not validate" (the sandbox never became healthy, the client's own
-- build failed, or the agent touched files outside its two-file scope) —
-- the failure mode this new mechanism's own audit trail needs to record.
ALTER TABLE capability_repairs DROP CONSTRAINT capability_repairs_capability_type_check;
ALTER TABLE capability_repairs ADD CONSTRAINT capability_repairs_capability_type_check
  CHECK (capability_type IN ('url-file-map-page', 'new-content-target', 'template-slot-derivation'));

ALTER TABLE capability_repairs DROP CONSTRAINT capability_repairs_outcome_check;
ALTER TABLE capability_repairs ADD CONSTRAINT capability_repairs_outcome_check
  CHECK (outcome IN ('repaired', 'ambiguous', 'foreign-domain', 'not-found', 'failed'));
