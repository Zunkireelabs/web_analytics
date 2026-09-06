-- The agent's own review of the PR it opened, tracked ALONGSIDE drafts.status
-- rather than inside it.
--
-- These are orthogonal facts, and conflating them would break real behaviour.
-- drafts.status answers "where is this change in its journey to being live";
-- 'pr_opened' there means a real PR exists and a human has not merged it.
-- agent_review_state answers a different question: "has the agent finished
-- checking its own work, and what did it conclude". A draft can be pr_opened
-- and agent_reviewing at the same time, because both are true.
--
-- Putting these in drafts.status instead would have broken the pipeline in
-- three places that all key off 'pr_opened':
--   - listDraftsAwaitingPrCheck (store/drafts.js) selects status='pr_opened',
--     so a draft moved to an agent state would stop being polled and never
--     be seen to merge.
--   - markDraftImplemented requires status='pr_opened' AND pr_state='merged'.
--     A draft sitting in 'ready_for_human_review' could never finalize, so a
--     human merging it would leave it stuck forever.
--   - runPrStatusPollForAllSites (job.js) walks the same set.
--
-- IT IS ALSO THE POINT, structurally. 'merged' is not a value this column can
-- hold, and reaching drafts.status='implemented' still requires GitHub
-- confirming pr_state='merged' — evidence of a human's action, which nothing
-- in this app produces. The agent can drive this column to its own terminal
-- states and no further. That separation is what makes "the agent cannot
-- merge" a property of the schema rather than a promise in a comment.
--
-- Written by implementers/lib/pr-self-review.js via
-- routes/action-center.js's checkDraftPrStatus — the one existing
-- GitHub-aware path. The reconciler is forbidden from calling GitHub (see its
-- own header) and does not touch this.

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS agent_review_state TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS agent_review_detail JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS agent_fix_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_agent_review_state_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_agent_review_state_check
  CHECK (agent_review_state IS NULL OR agent_review_state IN (
    'agent_reviewing',
    'agent_fixing',
    'ready_for_human_review',
    'needs_human_review'
  ));

COMMENT ON COLUMN drafts.agent_review_state IS
  'The agent''s own post-PR review lifecycle, orthogonal to drafts.status. NULL until a PR exists. Deliberately cannot express "merged": reaching implemented requires GitHub-confirmed evidence a human merged, which is drafts.status/pr_state, not this column.';
COMMENT ON COLUMN drafts.agent_review_detail IS
  'Evidence behind agent_review_state: the real check runs read from GitHub, each failure''s classification, and the recorded reason it was judged safe or unsafe to fix. Never a summary that omits a failure — a check that failed is recorded whether or not the agent could act on it.';
COMMENT ON COLUMN drafts.agent_fix_attempts IS
  'How many times the agent has pushed a corrective commit to this draft''s PR branch. Bounded by pr-self-review.js MAX_AGENT_FIX_ATTEMPTS so a defect the agent cannot actually fix escalates to needs_human_review instead of looping.';

CREATE INDEX IF NOT EXISTS idx_drafts_agent_review_state
  ON drafts (site_id, agent_review_state) WHERE agent_review_state IS NOT NULL;
