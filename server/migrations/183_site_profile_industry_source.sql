-- Where a site's industry came from, and how much to trust it.
-- (server/lib/industry-capture.js, server/store/data-analyst.js)
--
-- site_profiles.industry (080) is inferred by the Python keyword-clustering
-- collector from a site's own real top Search Console queries. That is a
-- good source and the only one — which leaves two holes:
--
--   1. A product tenant has no Search Console, so clustering never runs and
--      industry stays NULL forever. feedsForTenant then returns zero feeds
--      and trend radar reports "too few recent headlines", which reads as
--      "nothing is trending in your industry" rather than "nobody ever
--      recorded your industry". The tenant silently gets no trending
--      topics, permanently.
--
--   2. There is nowhere to record a staff-asserted industry. Writing one
--      into site_profiles.industry would work exactly once: saveSiteProfile
--      upserts industry unconditionally, so the next clustering run for a
--      tenant that DOES have GSC would quietly overwrite it. Without a
--      source column there is no way to tell a human assertion from an
--      inference, so there is no way to protect it.
--
-- industry_confidence is separate from source on purpose: an LLM
-- classification from a homepage is a real source with low confidence, and
-- a consumer that wants to demand corroboration (gapDraftEligibility) needs
-- to read the confidence without having to know which sources happen to be
-- weak this month.
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS industry_source     TEXT;
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS industry_confidence TEXT;

-- 'unmapped' is the honest fourth state and the reason this is a constrained
-- enum rather than free text: an industry string that the trend-feed catalog
-- cannot match (agents/lib/trend-feeds.js's industryIsMappable) is recorded
-- as captured-but-unusable, so trend radar can report a real capability gap
-- instead of looking like a tenant with no trends. 'inferred' is what the
-- Python clustering collector's own writes mean.
ALTER TABLE site_profiles DROP CONSTRAINT IF EXISTS site_profiles_industry_source_check;
ALTER TABLE site_profiles ADD CONSTRAINT site_profiles_industry_source_check
  CHECK (industry_source IS NULL OR industry_source IN ('human', 'growth-config', 'llm-classified', 'inferred', 'unmapped'));

ALTER TABLE site_profiles DROP CONSTRAINT IF EXISTS site_profiles_industry_confidence_check;
ALTER TABLE site_profiles ADD CONSTRAINT site_profiles_industry_confidence_check
  CHECK (industry_confidence IS NULL OR industry_confidence IN ('high', 'medium', 'low'));
