-- The day (in the project's own timezone) on which the daily run last built a person's approved picks and design choices.
-- Approving only SAVES; the scheduled run builds. The run claims the day once, so an approval made after that day's run
-- waits for the next day's run instead of causing a second commit on top the same day.
--
-- Additive and idempotent; no data statements.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS picks_built_on DATE;
