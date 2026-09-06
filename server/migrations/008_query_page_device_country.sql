-- Add device + country dimensions to gsc_query_page, and widen the primary key
-- so distinct device/country rows for the same (query, page) aren't collapsed
-- by the upsert's ON CONFLICT target.
ALTER TABLE gsc_query_page ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT '';
ALTER TABLE gsc_query_page ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'gsc_query_page'::regclass AND contype = 'p'
       AND pg_get_constraintdef(oid) LIKE '%device%country%'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'gsc_query_page'::regclass AND contype = 'p') THEN
      ALTER TABLE gsc_query_page DROP CONSTRAINT gsc_query_page_pkey;
    END IF;
    ALTER TABLE gsc_query_page ADD PRIMARY KEY (site_id, date, query, page, device, country);
  END IF;
END $$;
