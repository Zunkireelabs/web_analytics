-- Replaces the pr_opened step with a real "merged into stage" step for the
-- Action Center's git integration, matching the company's real CI/CD
-- convention (~/Travel/ci-cd-deployment-master-guide): stage has no
-- protection rules and deploys automatically on merge, so a PR isn't
-- required there — only production (main) would need one, and promoting
-- stage -> main stays a fully separate, manual, human action outside this
-- platform (see server/implementers/lib/github-ops.js). 'pr_opened' stays
-- in the allowed list for any historical row, even though no new draft will
-- use it going forward.
--
-- This is now the sole owner of drafts_status_check (024/029/038 used to
-- each redefine it too, but every migration file replays on every deploy —
-- see run.js — so an earlier, narrower redefinition would fail once live
-- rows reached a status only a later one allows). Any future status must
-- extend the CHECK list here, not add a new DROP/ADD elsewhere.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN ('draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'merged_to_stage', 'pr_opened', 'implemented'));

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS stage_merge_sha TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS stage_merge_url TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS stage_merged_at TIMESTAMPTZ;
