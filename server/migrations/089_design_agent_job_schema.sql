-- Step 6A of the OpenHands-based Design Agent integration: schema only,
-- no worker or OpenHands code exists yet. A 'design_generate' job created
-- by this step's trigger endpoint will sit in status='queued' until a
-- later step adds something that actually picks it up.
--
-- Extends execution_jobs (078) rather than adding a parallel table — its
-- existing shape (status/branch_name/pr_number/pr_url/logs/duration_ms)
-- already matches what a Design Job needs. `kind` is orthogonal to
-- `trigger` ('bulk'/'single'), so both coexist without conflict.
--
-- Design Jobs deliberately do NOT go through execution_job_recommendations
-- (078) — that table's draft_id/status shape models the bulk safe-fix
-- chain's per-item draft lifecycle, which doesn't apply here: a Design Job
-- has no `draft` row, its output is a real multi-file PR, not marker-patch
-- content. A direct nullable recommendation_id on execution_jobs is used
-- instead, only for kind='design_generate' rows.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_agent_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'content_apply'
  CHECK (kind IN ('content_apply', 'design_generate'));

ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS recommendation_id INTEGER REFERENCES recommendations(id);

CREATE INDEX IF NOT EXISTS execution_jobs_recommendation_idx
  ON execution_jobs (recommendation_id) WHERE recommendation_id IS NOT NULL;
