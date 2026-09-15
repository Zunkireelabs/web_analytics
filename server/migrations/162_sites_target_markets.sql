-- resolveSiteLocations (server/agents/lib/site-locations.js) only ever
-- returns a site's own country_code plus one shared global-default location
-- (migration 159) — enough for a single home market plus one broad
-- fallback, but not enough for a business that genuinely serves several
-- real markets at once (e.g. Zunkiree Labs: Nepal-based, but explicitly
-- serving clients in the US, UK, India, Australia, Canada, Switzerland,
-- Netherlands, and Germany too). This column lets a site name its own
-- explicit list of real markets to check keyword demand against, instead
-- of being limited to one home market plus one shared default.
--
-- JSONB, not a flat location-code array: DataForSEO's Keyword Data (Labs)
-- product validates language_code against location_code per request (a
-- German-language query against Germany succeeds; the same location with
-- 'en' is rejected outright — confirmed live). A single site-wide
-- language_code (as country_code/language_code already are, migration 159)
-- cannot serve a mixed-language market list, so each entry here carries its
-- own real language alongside its location.
--
-- NULL (the default) means "no explicit multi-market list" — every
-- existing site keeps behaving exactly as target_scope already dictates
-- (migration 159), no regression.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS target_markets JSONB;

-- Real, staff-confirmed markets for Zunkiree Labs (site 1): Nepal-based,
-- but explicitly a global technology/software/SEO company serving clients
-- everywhere, not just its home market or one default market. There is no
-- real "worldwide" location in DataForSEO's (or Google's own) keyword-
-- volume data — every lookup is per-country, and language-specific — so
-- "everywhere" is expressed as this explicit, growable list of real
-- markets rather than one that doesn't exist. Guarded so a later manual
-- edit isn't clobbered by a re-run.
-- Location codes: 2840 = United States, 2826 = United Kingdom,
-- 2356 = India, 2036 = Australia, 2124 = Canada, 2524 = Nepal,
-- 2756 = Switzerland, 2528 = Netherlands, 2276 = Germany. Each paired with
-- the real local language DataForSEO's keyword_ideas product actually
-- accepts for it (confirmed live) — English everywhere it's the real
-- search language, German for Germany and Switzerland, Dutch for the
-- Netherlands.
UPDATE sites SET target_markets = '[
  {"locationCode": 2840, "languageCode": "en"},
  {"locationCode": 2826, "languageCode": "en"},
  {"locationCode": 2356, "languageCode": "en"},
  {"locationCode": 2036, "languageCode": "en"},
  {"locationCode": 2124, "languageCode": "en"},
  {"locationCode": 2524, "languageCode": "en"},
  {"locationCode": 2756, "languageCode": "de"},
  {"locationCode": 2528, "languageCode": "nl"},
  {"locationCode": 2276, "languageCode": "de"}
]'::jsonb
  WHERE id = 1 AND target_markets IS NULL;
