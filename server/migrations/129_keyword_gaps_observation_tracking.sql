-- Content-gap autonomous shipping, phase 1: persistence tracking so a
-- keyword gap's real demand can be judged across more than one sighting
-- before it's ever eligible to auto-ship. keyword_gaps (081) was
-- deliberately append-only — "a topic can legitimately resurface across
-- runs... becomes a new row" — which is exactly what this migration changes
-- for still-pending rows: a resurfacing gap now updates the SAME row
-- (first_seen_at/last_seen_at/observation_count/evidence_snapshots) instead
-- of creating a duplicate, so server/store/data-analyst.js's saveKeywordGaps
-- can tell "seen once" from "seen again with growing demand." A gap a human
-- has already accepted or dismissed keeps its original append-only history —
-- only pending_review rows dedupe, via the partial unique index below.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS observation_count INT NOT NULL DEFAULT 1;
-- One entry per weekly discovery pass that resighted this topic:
-- {observed_at, impressions, position, source}, sourced from the same real
-- GSC getRelatedQueriesForTopic lookup classification already runs — "growing
-- demand" is judged from real numbers, never guessed.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS evidence_snapshots JSONB NOT NULL DEFAULT '[]';

UPDATE keyword_gaps SET first_seen_at = created_at WHERE first_seen_at IS NULL;
UPDATE keyword_gaps SET last_seen_at = created_at WHERE last_seen_at IS NULL;
ALTER TABLE keyword_gaps ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE keyword_gaps ALTER COLUMN last_seen_at SET NOT NULL;

-- Fold any pre-existing pending_review duplicates (same site_id+topic,
-- created before this migration, back when a resighting always inserted a
-- new row) into the earliest row rather than just deleting the signal:
-- observation_count is summed and last_seen_at/priority move to the latest
-- duplicate's values before the later rows are dropped, so a topic that
-- genuinely resurfaced several times under the old append-only behavior
-- isn't misread as a single, brand-new sighting once the unique index below
-- makes that impossible going forward.
WITH ranked AS (
  SELECT id, site_id, topic, priority, created_at,
         MIN(id) OVER (PARTITION BY site_id, topic) AS keep_id,
         COUNT(*) OVER (PARTITION BY site_id, topic) AS dup_count,
         FIRST_VALUE(priority) OVER (PARTITION BY site_id, topic ORDER BY created_at DESC) AS latest_priority,
         MAX(created_at) OVER (PARTITION BY site_id, topic) AS latest_created_at
    FROM keyword_gaps
   WHERE status = 'pending_review'
),
folded AS (
  UPDATE keyword_gaps kg
     SET observation_count = r.dup_count,
         last_seen_at = r.latest_created_at,
         priority = r.latest_priority
    FROM ranked r
   WHERE kg.id = r.keep_id AND r.dup_count > 1
   RETURNING kg.id
)
DELETE FROM keyword_gaps kg
 USING ranked r
 WHERE kg.status = 'pending_review'
   AND kg.id = r.id
   AND kg.id <> r.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_gaps_pending_dedup
  ON keyword_gaps (site_id, topic) WHERE status = 'pending_review';

-- Biweekly ship-cycle gate, same "marker column read/written directly"
-- pattern as sites.weekly_last_done (server/job.js) — deliberately NOT a
-- cron */14 day-of-month schedule (that drifts against a site's own
-- first-seen date); the qualify-and-ship pass reads this column to decide
-- whether 14 real days have passed since it last ran for this site.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS keyword_gap_ship_cycle_last_done TIMESTAMPTZ;
