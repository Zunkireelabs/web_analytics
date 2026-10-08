-- "This fix made this page worse — stop proposing it here."
-- (server/store/fix-suppressions.js)
--
-- Learning today is generator-level per site: generator_learning demotes a
-- whole generator for a whole site once its recent attempts have repeatedly
-- failed or been rejected. That is the right granularity for "this generator
-- is broken" and the wrong one for "this generator is fine, but it is wrong
-- for THIS page".
--
-- The gap is visible in fix_impact (104): a merged fix is measured ~31 days
-- later against real before/after Search Console windows, and a measurably
-- NEGATIVE result currently changes nothing at all. The same recommendation
-- is re-detected, re-drafted and re-shipped on the same page, and the only
-- brake is the per-attempt failure cap — which never trips, because the fix
-- does not fail. It applies cleanly and makes things worse.
--
-- scope/scope_key mirror work_claims (180) so "which page" means the same
-- thing in both tables. generator_id is part of the key here, unlike in
-- work_claims, and deliberately: this records that ONE kind of fix is wrong
-- for this page, not that the page is off limits.
--
-- suppressed_until is nullable: NULL means indefinite, a human decision.
-- Automatic suppressions always set a date (DEFAULT_SUPPRESSION_DAYS), because
-- a page that regressed in March may legitimately benefit from the same fix
-- after a redesign in September, and a permanent automatic ban would be
-- unfalsifiable.
--
-- Schema only, additive and idempotent — this directory re-runs every file on
-- every deploy.
CREATE TABLE IF NOT EXISTS fix_suppressions (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB,
  suppressed_until TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'impact-measurement',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at TIMESTAMPTZ
);

ALTER TABLE fix_suppressions DROP CONSTRAINT IF EXISTS fix_suppressions_scope_check;
ALTER TABLE fix_suppressions ADD CONSTRAINT fix_suppressions_scope_check
  CHECK (scope IN ('page', 'keyword', 'topic'));

-- One live suppression per (page, generator). Re-measuring the same
-- regression must refresh the existing row rather than stack duplicates, so
-- the writer upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS fix_suppressions_key
  ON fix_suppressions (site_id, scope, scope_key, generator_id);

-- The read path: auto-remediation loads every live suppression for a site
-- once per run, the same way it loads the learned-confidence map.
CREATE INDEX IF NOT EXISTS fix_suppressions_live_idx
  ON fix_suppressions (site_id) WHERE lifted_at IS NULL;
