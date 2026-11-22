-- Two projects may share one Search Console property AND one GA4 property when they own different paths (zennly.io: the marketplace
-- at / and the business site under /business, one domain, one GSC, one GA4). Migration 001 made (gsc_property, ga4_property_id) unique
-- on its own; this makes it unique per (gsc_property, ga4_property_id, scope_key), using the scope_key of migration 262.
--
-- An unscoped site has scope_key '|', so every existing row keeps exactly the uniqueness 001 gave it: two UNSCOPED sites still cannot
-- share a pair. NULLs stay distinct from each other, as in the original constraint (a product site has neither property).
--
-- Guarded: the original constraint is found by its columns (its generated name is not relied on) and only dropped once the new,
-- strictly looser index exists, so there is no window with no uniqueness at all.
CREATE UNIQUE INDEX IF NOT EXISTS sites_gsc_ga4_scope_unique ON sites (gsc_property, ga4_property_id, scope_key);

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'sites'::regclass AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text) FROM unnest(con.conkey) k JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k)
           = ARRAY['ga4_property_id', 'gsc_property']
  LOOP
    EXECUTE format('ALTER TABLE sites DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
