-- Deployment → production-verification gap (2026-09 lifecycle-gap audit,
-- finding #2). fix-impact.js's scheduleImpactMeasurement has always assumed
-- a human's merge IS a live deploy ("the merge is the only moment we know a
-- fix is genuinely live" — see routes/action-center.js's finalizeImplemented,
-- an explicit stated assumption, not a verified fact). deployments.js
-- (migration 153) already tracks the real signal — a live re-fetch actually
-- confirming the shipped content is present, via fix-verification.js — but
-- fix_impact never linked to it, so a merge that silently never deployed
-- (failed client-host build, a paused deploy hook) would still get measured
-- against real GSC data 31 days later as if it had.
--
-- Nullable: a fix_impact row with no deployment_id (an older row, or a merge
-- where recordDeploymentObserved itself failed) measures exactly as it
-- always has — this only adds a check for rows that DO have one, never
-- narrows existing behavior.
ALTER TABLE fix_impact
  ADD COLUMN IF NOT EXISTS deployment_id INTEGER REFERENCES deployments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fix_impact_deployment_idx ON fix_impact (deployment_id) WHERE deployment_id IS NOT NULL;
