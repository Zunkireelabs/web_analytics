-- The setup PR: one pull request per project, opened about an hour after the onboarding audit finishes, that adds the (empty) SEOAI
-- marker regions to the project's templates so the daily fixes that follow have a place to go (implementers/lib/setup-pr.js,
-- lib/setup-pr-job.js).
--
-- setup_pr_due_at   when it may run. NULL = never scheduled, so existing projects do NOT fire on deploy; they are scheduled by hand
--                   with scripts/schedule-setup-pr.js, and new projects are scheduled when their onboarding audit completes.
-- setup_pr_done_at  set once the PR is open, or once there was genuinely nothing to add. A done project is never scheduled again.
-- setup_pr_result   what happened, for the Platform page and for support: { status, prUrl, branch, files, markers, coverage, ... }
--
-- Added with plain ADD COLUMN and no UPDATE: an UPDATE over `sites` rewrote rows once before (migration 230's note) and a re-check
-- failed on projects whose baseline_run_id points at a missing agent_runs row.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS setup_pr_due_at      TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS setup_pr_done_at     TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS setup_pr_attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS setup_pr_last_error  TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS setup_pr_result      JSONB;
