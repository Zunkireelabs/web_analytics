-- GitHub's own mergeable_state for this draft's open PR (e.g. 'clean',
-- 'dirty', 'unstable', 'blocked'), recorded whenever checkDraftPrStatus
-- reads the PR — previously discarded (server/github/client.js's
-- getPullRequest only kept {state, merged}). Without this, the app had no
-- way to proactively flag "this PR can no longer auto-merge" short of a
-- human opening it on GitHub directly and seeing the conflict banner
-- themselves, which is exactly how a real incident went unnoticed for days.
-- Nullable/purely additive; null while GitHub is still computing it
-- (immediately after a push) or before the first status check.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pr_mergeable_state TEXT;
