-- Stage 2d of the Business Goals plan (goal-driven-prioritization, item 10 —
-- see server/agents/lib/goal-alignment.js and migration 171_site_goals.sql).
--
-- 171 already traces a recommendation to the goal it aligned with at sync
-- time. This closes the other half of the chain: recommendation -> draft ->
-- the fix_impact row that measures what shipping it actually did to real
-- Search Console numbers (see 104_fix_impact.sql). Without this column a
-- future "Goal Progress" view would have to re-derive the link at read time
-- by re-joining drafts back to whichever recommendation.finding_ids
-- contained draft.finding_id — fragile, since a merged recommendation's
-- finding_ids can grow after the draft that measured it was scheduled.
-- Recording goal_id at scheduling time (server/store/fix-impact.js's
-- scheduleImpactMeasurement) instead makes it a fact of that measurement,
-- not something recomputed later against data that may have moved on.
--
-- Nullable and never backfilled for existing rows: a fix scheduled before
-- this column existed, or one whose recommendation had no active goal at
-- merge time, genuinely has no goal to attribute to — NULL is the honest
-- answer, not a guess.
ALTER TABLE fix_impact
  ADD COLUMN IF NOT EXISTS goal_id INTEGER REFERENCES site_goals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fix_impact_goal_idx ON fix_impact (goal_id) WHERE goal_id IS NOT NULL;
