-- Where a LOCAL client actually works: named towns and cities, most important first.
--
-- A country code says "the United Kingdom"; it cannot say "Northampton, then the towns around it". For a local business
-- that is the difference between researching "estate agents" (a national term it can never win) and "estate agents
-- Northampton" (the search its customers actually type). Everything location-shaped is built from this: market research
-- seeds, which keywords count as location work, the questions asked of AI assistants, the keywords worth tracking, and
-- the local guidance handed to content generators.
--
-- Shape: a JSON array, ORDER = PRIORITY, each entry { "name": "Northampton", "tier": "primary" | "nearby" }.
-- A flat ordered list rather than a table: it is read whole, it is short (a dozen at most), and the order is the
-- meaning. A tier of 'primary' is the place the business is based and should win first; 'nearby' places are researched
-- after it, never before, so a capped run spends its budget on the home town first.
--
-- Empty by default, which means "no declared places": every existing site behaves exactly as it did, falling back to its
-- country. Nothing is inferred from a site's address or content — a place a business did not declare is a place it must
-- not be told it serves.
--
-- Additive and idempotent, like every file here; no data statements — no existing site is changed by this migration.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS target_places JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_target_places_check;
ALTER TABLE sites ADD CONSTRAINT sites_target_places_check
  CHECK (jsonb_typeof(target_places) = 'array' AND jsonb_array_length(target_places) <= 20);
