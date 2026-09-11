-- Every DataForSEO caller in this codebase (keyword-demand.js,
-- competitor-analysis.js, location-service-gap.js, ingest/competitors.js)
-- previously queried the SAME hardcoded location via one global env var
-- (COMPETITOR_LOCATION_CODE, defaulting to 2840 = United States) for every
-- tenant — so a UK client and a Nepal client both got US keyword demand.
-- This gives each site its own real target market instead.
--
-- target_scope decides how agents/lib/site-locations.js resolves which
-- location(s) to query:
--   'global' (default) - unchanged from pre-159 behavior: only the env-var
--     default location. A site with no country_code set stays exactly as
--     it behaved before this migration.
--   'local'  - only this site's own country_code/language_code (e.g. a
--     single-country business with no reason to dilute results with
--     unrelated global demand).
--   'hybrid' - this site's own country_code PLUS the env-var default, so a
--     site with a real home market AND real global reach isn't limited to
--     either alone.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS country_code INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS target_scope TEXT NOT NULL DEFAULT 'global'
  CHECK (target_scope IN ('local', 'global', 'hybrid'));

-- Provenance: which resolved location a given real-demand keyword idea
-- actually came from, so a hybrid site's local-market and global-market
-- gaps stay distinguishable after they land in the same table.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS location_code INTEGER;

-- Real, staff-confirmed target markets for the three sites already live
-- today. Guarded so a later manual edit isn't clobbered by a re-run.
-- 2826 = United Kingdom, 2524 = Nepal.
UPDATE sites SET country_code = 2826, language_code = 'en', target_scope = 'local'
  WHERE id = 8864 AND country_code IS NULL; -- Chayceproperties: UK-only property business
UPDATE sites SET country_code = 2524, language_code = 'en', target_scope = 'hybrid'
  WHERE id = 8862 AND country_code IS NULL; -- Admizz Education: Nepal-based, also serves students going abroad
UPDATE sites SET country_code = 2524, language_code = 'en', target_scope = 'hybrid'
  WHERE id = 1 AND country_code IS NULL; -- Zunkiree Labs: Nepal-based, but a global technology/software/SEO company
