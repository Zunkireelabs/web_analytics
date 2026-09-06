-- Adds the missing 'url-file-map-adapter' capability_type value.
-- server/implementers/lib/pagination-adapter-discovery.js's healPaginationAdapter
-- has called recordCapabilityRepair(..., { capabilityType: 'url-file-map-adapter' })
-- since it was introduced, but that value was never added to the check
-- constraint (migration 126 only listed 'url-file-map-page', 'new-content-target',
-- 'template-slot-derivation'). recordCapabilityRepair swallows the resulting
-- insert failure (by design — an audit-log write must never break a real
-- repair attempt), so this was silent: every pagination-adapter heal attempt
-- — ambiguous or repaired — has been running correctly but leaving zero trace
-- in capability_repairs, the same audit trail every other heal mechanism
-- relies on for visibility. Confirmed live (2026-08-27): running
-- healPaginationAdapter against real site data throws exactly
-- "violates check constraint capability_repairs_capability_type_check" on
-- every attempt.
ALTER TABLE capability_repairs DROP CONSTRAINT capability_repairs_capability_type_check;
ALTER TABLE capability_repairs ADD CONSTRAINT capability_repairs_capability_type_check
  CHECK (capability_type IN ('url-file-map-page', 'new-content-target', 'template-slot-derivation', 'url-file-map-adapter'));
