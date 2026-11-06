-- Close the Supabase advisory "rls_disabled_in_public" (31 Oct 2026, project autonomous-seo): every table in `public`
-- without Row-Level Security can be read, edited and deleted through Supabase's public REST API by anyone holding the
-- project URL and anon key. Tables created by migrations since the one-time dashboard enable never got RLS, including
-- sign-in codes, resume links, sign-up details, leads and workspace/project membership.
--
-- Why this is safe for the app: it talks to Postgres directly over `pg` (and the Python analyst service over the same
-- pooler URL) as the `postgres` role, which bypasses RLS. No Supabase client, anon key or service-role key is used in
-- the code. Enabling RLS with no policies therefore changes nothing for the app; it only makes the REST API's `anon`
-- and `authenticated` roles see zero rows, the same state the other tables already have. ENABLE, not FORCE: owners and
-- BYPASSRLS roles keep working exactly as before.
--
-- Idempotent and structure-only (no data statements). Re-running does nothing once every table is covered.

-- 1. Every existing public table that still lacks RLS. A table we cannot alter (owned by another role) is reported and
--    skipped rather than failing the whole deploy.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
     ORDER BY c.relname
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'RLS not enabled on public.% (insufficient privilege)', r.relname;
    END;
  END LOOP;
END $$;

-- 2. Stop it coming back: any table created later in `public` gets RLS automatically, so a future migration cannot
--    reopen this hole by forgetting a line. Best-effort: if the database user may not create event triggers, step 1
--    still applied and this is skipped with a warning.
CREATE OR REPLACE FUNCTION public.ensure_rls_on_new_tables() RETURNS event_trigger
LANGUAGE plpgsql AS $fn$
DECLARE obj record;
BEGIN
  FOR obj IN
    SELECT object_identity FROM pg_event_trigger_ddl_commands()
     WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       AND schema_name = 'public' AND object_type = 'table'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END
$fn$;

DO $$
BEGIN
  DROP EVENT TRIGGER IF EXISTS ensure_rls_on_new_tables;
  CREATE EVENT TRIGGER ensure_rls_on_new_tables ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    EXECUTE FUNCTION public.ensure_rls_on_new_tables();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Auto-RLS event trigger not created (insufficient privilege); existing tables were still covered.';
END $$;
