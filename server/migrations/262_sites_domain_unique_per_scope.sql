-- Two projects may share one domain in a workspace when they own different paths (zennly.io: marketplace at /, business site under
-- /business). Migration 210 made (workspace, domain) unique; this makes it unique per (workspace, domain, path scope).
--
-- scope_key is a plain column kept up to date by a trigger because an index expression must be immutable and array-to-text is not.
-- An unscoped site has the key '|', so every existing row keeps exactly the uniqueness migration 210 gave it.
-- Format: <include prefixes sorted, comma-joined>|<exclude prefixes sorted, comma-joined>  (mirrored by scopeKey() in agents/lib/site-scope.js).
--
-- Guarded like 210: the new index is only created when existing data already satisfies it, and the old one is only dropped then.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT '|';

CREATE OR REPLACE FUNCTION sites_set_scope_key() RETURNS trigger AS $$
BEGIN
  NEW.scope_key :=
    coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(NEW.scope_include_paths) p), '') || '|' ||
    coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(NEW.scope_exclude_paths) p), '');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sites_scope_key_trg ON sites;
CREATE TRIGGER sites_scope_key_trg BEFORE INSERT OR UPDATE OF scope_include_paths, scope_exclude_paths ON sites
  FOR EACH ROW EXECUTE FUNCTION sites_set_scope_key();

UPDATE sites SET scope_include_paths = scope_include_paths WHERE scope_key = '|' AND cardinality(scope_include_paths) + cardinality(scope_exclude_paths) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS sites_workspace_domain_scope_unique
  ON sites (workspace_id, lower(website_domain), scope_key)
  WHERE website_domain IS NOT NULL AND workspace_id IS NOT NULL AND status IS DISTINCT FROM 'soft_deleted';
-- The new index is strictly looser than 210's, so it can always be created where 210's exists; drop the old one only afterwards.
DROP INDEX IF EXISTS sites_workspace_domain_unique;
