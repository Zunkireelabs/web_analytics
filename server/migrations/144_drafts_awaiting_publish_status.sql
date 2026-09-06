-- Adds 'awaiting_publish' to drafts_status_check: a draft whose change has
-- been written to a CMS as a real, reviewable draft document and is now
-- waiting for a human to publish it.
--
-- This is the CMS analogue of 'pr_opened', and it exists for the same reason
-- that status does: the work is done, it is visible for review, and the last
-- step is deliberately a person's. server/implementers/adapters/sanity-document.js
-- is the first writer to reach it.
--
-- Why not reuse an existing status:
--
--   - 'pr_opened' carries a real GitHub PR number. listDraftsAwaitingPrCheck
--     (store/drafts.js) selects on pr_number, and checkDraftPrStatus
--     (routes/action-center.js), driven by the hourly poll and the PR webhook,
--     calls getPullRequest() with it. A Sanity draft parked there would send
--     the poller looking for a pull request that does not exist, on every
--     site, every hour.
--   - 'branch_pushed' is in the reconciler's RECLAIMABLE_STATUSES
--     (lib/action-center-reconciler.js), so a Sanity draft correctly waiting
--     on a human would be abandoned as "stalled" after IDLE_RECLAIM_HOURS.
--     Waiting for a person is this state's whole purpose, not a stall.
--     'awaiting_publish' is deliberately NOT reclaimable, exactly like
--     'pr_opened'.
--   - 'merged_to_stage' means live. A CMS draft document is not live.
--
-- Ownership: this migration takes over drafts_status_check from 039, per the
-- convention 142 records — a CHECK list has exactly one owning migration, and
-- a new value extends that owner's list rather than adding another DROP/ADD
-- somewhere else. Any future draft status must extend the list HERE.
--
-- The value list below is 039's, verbatim, plus 'awaiting_publish'.

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN (
    'draft',
    'edited',
    'submitted_for_approval',
    'approved',
    'branch_pushed',
    'merged_to_stage',
    'pr_opened',
    'awaiting_publish',
    'implemented',
    'abandoned',
    'revision_requested'
  ));

-- Evidence columns for the CMS path, mirroring pr_number/pr_url's role for
-- the GitHub path: which document was written, and where a human can go to
-- review and publish it. NULL for every GitHub-path draft.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cms_document_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cms_review_url TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cms_published_at TIMESTAMPTZ;

COMMENT ON COLUMN drafts.cms_document_id IS
  'The CMS document this draft wrote, e.g. "drafts.abc123" for a Sanity draft document. NULL for GitHub-path drafts.';
COMMENT ON COLUMN drafts.cms_review_url IS
  'Deep link a human opens to review and publish the CMS draft (e.g. a Sanity Studio document URL). The CMS analogue of pr_url.';
COMMENT ON COLUMN drafts.cms_published_at IS
  'When a human published the CMS draft. Set only from a real read-back confirming the published document carries the change — never on the strength of a mutation response alone.';
