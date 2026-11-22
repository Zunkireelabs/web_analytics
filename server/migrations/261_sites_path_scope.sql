-- Path scope: which URL paths on a site's domain belong to THIS site.
--
-- Why: one domain can host more than one SuperRank site. zennly.io serves a
-- marketplace at / and the older business site under /business; both share
-- one Search Console domain property. Hostname filtering (additional_own_domains,
-- seo_ignored_hosts) cannot tell them apart, so without a path scope each
-- site's agents, URL audit and implementers would work on the other's pages.
--
--   scope_include_paths  path prefixes this site owns. Empty = the whole
--                        domain (today's behaviour for every site).
--   scope_exclude_paths  path prefixes this site must never touch, even when
--                        inside an include. Exclude always wins.
--
-- A prefix is matched on a path-segment boundary: '/business' covers
-- /business, /business/ and /business/blog/x, never /businesses.
--
-- Both default to empty, so every existing site keeps today's behaviour until
-- a scope is recorded. Empty means "no path restriction", never "nothing".
ALTER TABLE sites ADD COLUMN IF NOT EXISTS scope_include_paths TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS scope_exclude_paths TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN sites.scope_include_paths IS
  'Path prefixes (e.g. /business) this site owns on its domain. Empty = whole domain. Matched on a path-segment boundary.';
COMMENT ON COLUMN sites.scope_exclude_paths IS
  'Path prefixes this site must never read, report on or write to, even inside an include. Exclude wins. Lets two sites share one domain and one Search Console property.';
