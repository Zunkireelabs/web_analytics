-- Minimum spacing, in days, between two blog posts the unattended loop
-- (agents/lib/auto-remediation.js) ships for a site.
--
-- blog-outline became a 'safe'-tier generator (agents/lib/risk-tiers.js) so
-- the agent could grow impressions with new content instead of only fixing
-- existing pages. What that promotion did NOT come with is any notion of
-- publishing cadence: auto-remediation filters candidates by risk tier and
-- drafted-status only, so every open blog-outline recommendation is eligible
-- in the same run. Site 1 has 28 of them open at the time of writing, which
-- means the first run after auto_remediation_enabled was turned on would have
-- opened blog PRs in bulk until the 30/day budget ran out.
--
-- A burst like that is wrong on two counts: it is unreviewable (a human is
-- still the merge gate, and nobody reviews a dozen articles in an afternoon),
-- and it does not look like a real publishing schedule to either readers or
-- search engines.
--
-- 3 days is the deliberate default. It is a MINIMUM GAP, not a quota: the
-- agent never invents a topic to fill it. It draws from genuinely detected
-- content gaps (content-gap, ai-recommendation), so a site with nothing to
-- write about ships nothing and simply waits, exactly as it does today.
-- Per-site so a content-heavy client can be tightened and a cautious one
-- widened without a code change. 0 disables the gap entirely.
--
-- The blog still competes for the SAME daily budget as every other fix
-- (auto_remediation_daily_limit, migration 101) rather than getting a
-- separate allowance — at most one blog occupies one of those 30 slots on
-- the days it is due, and the rest go to ordinary fixes as before.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS blog_min_gap_days INTEGER NOT NULL DEFAULT 3;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_blog_min_gap_days_check;
ALTER TABLE sites ADD CONSTRAINT sites_blog_min_gap_days_check
  CHECK (blog_min_gap_days >= 0);
