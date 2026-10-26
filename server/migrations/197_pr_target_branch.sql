-- Where a project's batch pull request is opened, when that is not the branch
-- the work is cut from.
--
-- Some sites promote content through a stage branch: the day's batch branch is
-- cut from the production branch (sites.repo_default_branch, usually main) and
-- its PR is opened into `stage`, then stage is promoted to main by hand. Until
-- now the PR always went into repo_default_branch — a deliberate choice, so a
-- batch's diff only ever holds that batch — and a site that wanted stage had no
-- way to say so.
--
-- NULL means "the PR goes into repo_default_branch", exactly as before, so no
-- existing site changes behaviour. The branch work is CUT from is unchanged
-- either way (always repo_default_branch).
--
-- Additive and idempotent, like every file in this directory.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS pr_target_branch TEXT;
