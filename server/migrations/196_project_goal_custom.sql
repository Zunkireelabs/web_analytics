-- A project's goal can be written in the person's own words instead of being
-- picked from the four presets (194). "Something else" in the New project flow
-- stores goal = 'custom' plus the sentence they typed in custom_text.
--
--   growth  stays NOT NULL on the table, but carries no meaning for a custom
--           goal — validateGoal (server/store/workspaces.js) pins it to
--           'steady' so the existing column and its CHECK keep working without
--           a nullable migration on a table that already has live rows.
--   months  still applies: a custom goal is a goal "in how long".
--
-- Additive only and idempotent, same posture as 194.

ALTER TABLE project_goals ADD COLUMN IF NOT EXISTS custom_text TEXT;

ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_goal_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_goal_check
  CHECK (goal IN ('google_visitors', 'enquiries', 'ai_answers', 'key_rankings', 'custom'));

-- A custom goal must carry its text, and a preset one must not: the sentence
-- shown to the person comes from the key for a preset and from this column for
-- a custom goal, so a row that has both (or neither) has no single answer.
ALTER TABLE project_goals DROP CONSTRAINT IF EXISTS project_goals_custom_text_check;
ALTER TABLE project_goals ADD CONSTRAINT project_goals_custom_text_check
  CHECK ((goal = 'custom') = (custom_text IS NOT NULL AND btrim(custom_text) <> ''));
