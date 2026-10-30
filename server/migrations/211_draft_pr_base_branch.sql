-- Which branch a draft's pull request was opened INTO. For a site that promotes through a stage branch
-- (sites.pr_target_branch) a merge lands on stage first and only reaches the live site when stage is
-- promoted, so "merged" and "live" are different facts. Recorded when the PR is opened, so it stays true
-- even if the site's setting changes later. Additive and nullable (older drafts are NULL).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pr_base_branch TEXT;
