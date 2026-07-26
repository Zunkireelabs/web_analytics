-- Platform Administration, Phase 0, corrective FK migration (see
-- PLATFORM-ADMIN-DESIGN.md §G.3a). Re-verified directly against all 61
-- prior migrations for the design's review pass: growth_targets.site_id,
-- integration_health.site_id, and signup_requests.created_site_id were all
-- declared with a bare `REFERENCES sites(id)`, which Postgres defaults to
-- `ON DELETE NO ACTION` — that silently *blocks* `DELETE FROM sites` for
-- any tenant with rows in these tables, which Phase 3.5's hard-delete
-- depends on not happening.
--
-- growth_targets/integration_health -> CASCADE: both are purely derived/
-- operational tenant data, safe to remove with the tenant.
-- signup_requests.created_site_id -> SET NULL: preserves the historical
-- fact that a signup request existed and was approved even after the
-- resulting tenant is later hard-deleted — same "preserve history over the
-- referenced row" reasoning api_tokens.created_by (054) and
-- drafts.approved_by (024) already use.
--
-- The original constraint names are whatever Postgres auto-generated on
-- creation (unnamed inline REFERENCES). Rather than hardcode a guessed
-- default name, each block looks up the live FK constraint name on the
-- target column and drops it by that name, then adds a fixed, explicitly
-- named replacement — so this file is safe to re-run every deploy
-- (first run: drops the auto-generated name; every run after: drops and
-- re-adds the same named constraint it already created, a no-op in effect).

DO $$
DECLARE
  cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'growth_targets'
    AND kcu.column_name = 'site_id'
    AND tc.constraint_type = 'FOREIGN KEY';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE growth_targets DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE growth_targets
    ADD CONSTRAINT growth_targets_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'integration_health'
    AND kcu.column_name = 'site_id'
    AND tc.constraint_type = 'FOREIGN KEY';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE integration_health DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE integration_health
    ADD CONSTRAINT integration_health_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'signup_requests'
    AND kcu.column_name = 'created_site_id'
    AND tc.constraint_type = 'FOREIGN KEY';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE signup_requests DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE signup_requests
    ADD CONSTRAINT signup_requests_created_site_id_fkey
    FOREIGN KEY (created_site_id) REFERENCES sites(id) ON DELETE SET NULL;
END $$;
