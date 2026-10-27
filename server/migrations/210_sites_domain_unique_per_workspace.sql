-- A website can be a project in a workspace only once. Enforced here, not just in the form, so two
-- tabs (or a retry) cannot add the same site twice. Compared lower-cased; deleted projects don't count.
--
-- Created only when the existing data already satisfies it: a deploy must never fail on old rows. If
-- duplicates exist, this logs which and leaves the index out; the route-level check still applies.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sites
     WHERE website_domain IS NOT NULL AND workspace_id IS NOT NULL AND status IS DISTINCT FROM 'soft_deleted'
     GROUP BY workspace_id, lower(website_domain) HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'sites_workspace_domain_unique NOT created: duplicate website_domain values exist within a workspace. Resolve them, then re-run this statement.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS sites_workspace_domain_unique
      ON sites (workspace_id, lower(website_domain))
      WHERE website_domain IS NOT NULL AND workspace_id IS NOT NULL AND status IS DISTINCT FROM 'soft_deleted';
  END IF;
END $$;
