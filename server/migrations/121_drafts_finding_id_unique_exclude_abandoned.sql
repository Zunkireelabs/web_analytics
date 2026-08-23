-- Corrective follow-up to 118: this Supabase project already had 118 applied
-- (recorded in schema_migrations) using its ORIGINAL SQL — a plain unique
-- index on (site_id, finding_id) with no carve-out for abandoned drafts —
-- before the fix below was made to that file. The migration runner never
-- re-runs an already-applied filename (see run.js's own comment on this
-- exact class of situation: 082/099), so editing 118 in place has no effect
-- here; a new migration is the only way to correct an already-migrated
-- database. A brand-new database that has never run 118 gets the fixed
-- version directly and never needs this file at all — both paths converge
-- on the same final index.
DROP INDEX IF EXISTS drafts_site_finding_id_unique;

-- Same defensive pre-cleanup as 118, re-run here in case any drafts were
-- created between 118's original apply and this fix (harmless no-op if
-- drafts is empty, as it is on a freshly re-pointed database).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY site_id, finding_id
    ORDER BY (status <> 'abandoned') DESC, created_at DESC, id DESC
  ) AS rn
  FROM drafts
  WHERE finding_id IS NOT NULL
)
UPDATE drafts SET finding_id = NULL
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS drafts_site_finding_id_unique
  ON drafts (site_id, finding_id)
  WHERE finding_id IS NOT NULL AND status <> 'abandoned';
