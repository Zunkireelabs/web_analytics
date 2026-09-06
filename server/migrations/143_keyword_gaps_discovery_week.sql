-- Attributes every keyword gap to a calendar discovery week, and makes the
-- observation_count increment idempotent WITHIN that week.
--
-- Two separate problems, one mechanism:
--
-- 1. WEEK ATTRIBUTION. The Monday ship cycle
--    (server/agents/lib/analyst-seo-mapping.js's qualifyAndShipContentGaps,
--    driven by job.js's runKeywordGapShipCycleForAllSites) must ship the
--    PREVIOUS week's qualified opportunities and must never ship one
--    discovered by the same Monday's own discovery pass. Nothing in the table
--    could express that before: created_at/first_seen_at/last_seen_at are
--    instants, and the discovery cadence was a rolling 7-day window measured
--    from each site's own site_profiles.profiled_at
--    (data-analyst-agent/app/collectors/keyword_clustering.py), so two sites
--    connected on different days had discovery boundaries on different
--    weekdays and "last week's gaps" was not a question the data could answer.
--    first_discovery_week pins the ISO-week Monday a gap was first seen;
--    last_observed_week pins the most recent week an observation counted.
--
-- 2. DOUBLE-RUN SAFETY. observation_count's increment
--    (server/store/data-analyst.js's saveKeywordGaps) is a genuine
--    `+ 1`, not an absolute-value upsert like metric_observations' — so it is
--    the one write in the nightly pipeline that a second same-day run would
--    corrupt. Staging currently DOES run the pipeline twice a day: the
--    in-process APScheduler (data-analyst-agent/app/ingestion/scheduler.py,
--    03:00/04:00 UTC) and a host crontab installed by
--    .github/workflows/deploy-staging.yml (22:00 UTC) both execute the same
--    run_nightly() over the same collectors, with no lock between them.
--    That has not corrupted counts to date only by accident: the collector's
--    unrelated RECLUSTER_INTERVAL_DAYS gate reads profiled_at, which the
--    first run of the day sets to today, so the second run returns early.
--    Moving discovery to a calendar-week boundary (problem 1) removes that
--    accidental protection, so the guard has to become explicit and live
--    with the increment itself rather than depending on an unrelated cadence
--    check upstream continuing to intercept the second run.
--
--    With last_observed_week, the increment is gated on the week strictly
--    advancing. Re-running discovery any number of times inside one calendar
--    week bumps last_seen_at but leaves observation_count alone, so
--    observation_count keeps meaning "distinct weeks this topic was genuinely
--    re-observed" — which is exactly what qualifyAndShipContentGaps's
--    `observation_count >= 2` threshold is asking about.
--
-- Backfill sets both columns from the timestamps already on each row, so
-- existing gaps keep their real history rather than being reset: a row last
-- seen in an earlier week is genuinely eligible to increment on its next real
-- re-observation, and one already seen this week is not. No observation_count
-- value is altered here.

ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS first_discovery_week DATE;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS last_observed_week DATE;

UPDATE keyword_gaps
   SET first_discovery_week = COALESCE(first_discovery_week, (date_trunc('week', first_seen_at AT TIME ZONE 'UTC'))::date),
       last_observed_week  = COALESCE(last_observed_week,  (date_trunc('week', last_seen_at  AT TIME ZONE 'UTC'))::date)
 WHERE first_discovery_week IS NULL OR last_observed_week IS NULL;

COMMENT ON COLUMN keyword_gaps.first_discovery_week IS
  'Monday (UTC) of the ISO week this topic was first discovered. Set once on insert; never moves. Used to answer "which week does this opportunity belong to" for the Monday ship cycle.';
COMMENT ON COLUMN keyword_gaps.last_observed_week IS
  'Monday (UTC) of the most recent ISO week an observation counted for this topic. saveKeywordGaps increments observation_count only when a re-sight advances this past its stored value, so repeated runs inside one week (or a duplicated nightly pipeline) cannot double-count.';

CREATE INDEX IF NOT EXISTS idx_keyword_gaps_discovery_week
  ON keyword_gaps (site_id, status, first_discovery_week);
