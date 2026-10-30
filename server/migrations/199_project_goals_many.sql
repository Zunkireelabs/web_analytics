-- A project can aim at more than one thing: "more visitors" AND "more enquiries"
-- AND "show up in AI answers". Until now a goal row held exactly one.
--
--   goals  every goal ticked, in the order they were ticked, any of the four presets
--          plus 'custom'. NULL on every row written before this migration.
--   goal   (existing) stays as the PRIMARY goal — the first one ticked — so everything
--          that already reads it (194/196, the workspace screens) keeps working
--          unchanged, and old rows need no rewrite. Code reads `goals`, and falls
--          back to [goal] when it is NULL.
--
-- The 196 rule "custom text if and only if the goal is custom" has to follow the new
-- shape: custom text now belongs to a row whose goals INCLUDE 'custom', which need not
-- be the primary goal. Same rule, restated over the whole list.
--
-- Additive and idempotent, like every file here; no data statements.

ALTER TABLE project_goals ADD COLUMN IF NOT EXISTS goals TEXT[];

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_goals_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_goals_check
  CHECK (goals IS NULL OR (
    cardinality(goals) BETWEEN 1 AND 5
    AND goals <@ ARRAY['google_visitors', 'enquiries', 'ai_answers', 'key_rankings', 'custom']::text[]
    AND goal = goals[1]
  ));

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_custom_text_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_custom_text_check
  CHECK (('custom' = ANY (COALESCE(goals, ARRAY[goal]))) = (custom_text IS NOT NULL AND btrim(custom_text) <> ''));
