-- Keyword schedule (server/agents/lib/keyword-schedule.js), owner's plan of 2026-11-18:
--   days 1-30 of a project's growth clock (sites.growth_started_at): gather keywords only;
--   day 31: ship the first half of the gathered keywords; track their impressions for 14 days;
--   day 45: ship the second half (and half of anything gathered since), fix first-half keywords with few impressions;
--   then every 14 days the same. A keyword that fits an existing page is added to it; one that needs a page becomes a
--   blog, paced by the project's blog gap. Keywords added by hand ship on the next blog day.
--
-- Additive and idempotent; no data statements.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS schedule_batch      INTEGER;      -- the cycle this keyword ships in (NULL = not yet assigned)
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS ship_mode           TEXT;         -- 'existing_page' | 'new_blog' | 'faq'
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS target_page         TEXT;         -- the existing page it was added to
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS scheduled_for       DATE;         -- earliest day it may ship (blogs: its blog day)
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS recommendation_id   INTEGER;      -- the Action Center item it became
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS shipped_at          TIMESTAMPTZ;  -- when its draft was merged (from drafts.implemented_at)
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS impressions_14d     INTEGER;      -- impressions for this keyword in the 14 days after shipped_at
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS impressions_measured_at TIMESTAMPTZ;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS followup_recommendation_id INTEGER; -- the fix queued because impressions were low
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS followup_note       TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS keyword_cycle_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS keyword_cycle_last_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS keyword_gaps_schedule_idx ON keyword_gaps (site_id, status, schedule_batch);
CREATE INDEX IF NOT EXISTS keyword_gaps_tracking_idx ON keyword_gaps (site_id, shipped_at) WHERE shipped_at IS NOT NULL;
