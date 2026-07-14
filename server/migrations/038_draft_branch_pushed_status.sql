-- Splits the old atomic "branch+commit+PR in one apply()" into two real,
-- separately-triggered steps: approved -> branch_pushed -> pr_opened. Gives
-- staff a real manual checkpoint (review the real pushed branch's diff in
-- the dashboard) between "a real change exists on a branch" and "a PR is
-- open" — see server/implementers/lib/github-ops.js's pushDraftBranch/
-- openPrForBranch and server/store/drafts.js's markDraftBranchPushed.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN ('draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'pr_opened', 'implemented'));
