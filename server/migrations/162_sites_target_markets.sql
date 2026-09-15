-- resolveSiteLocations (server/agents/lib/site-locations.js) only ever
-- returns a site's own country_code plus one shared global-default location
-- (migration 159) — enough for a single home market plus one broad
-- fallback, but not enough for a business that genuinely serves several
-- real markets at once (e.g. Zunkiree Labs: Nepal-based, but serving
-- clients in the US, UK, India, Australia, and Canada). This column lets a
-- site name its own explicit list of real markets to check keyword demand
-- (and, for any future caller that iterates the full array rather than just
-- locations[0]) against, instead of being limited to one home market plus
-- one shared default.
--
-- NULL (the default) means "no explicit multi-market list" — every
-- existing site keeps behaving exactly as target_scope already dictates
-- (migration 159), no regression.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS target_market_codes INTEGER[];

-- Real, staff-confirmed markets for Zunkiree Labs (site 1): Nepal-based,
-- but explicitly a global technology/software/SEO company serving clients
-- everywhere, not just its home market or one default market. Guarded so a
-- later manual edit isn't clobbered by a re-run.
-- 2840 = United States, 2826 = United Kingdom, 2356 = India,
-- 2036 = Australia, 2124 = Canada, 2524 = Nepal.
UPDATE sites SET target_market_codes = ARRAY[2840, 2826, 2356, 2036, 2124, 2524]
  WHERE id = 1 AND target_market_codes IS NULL;
