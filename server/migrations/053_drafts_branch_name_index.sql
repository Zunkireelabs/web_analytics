-- Supports the Action Center's shared-batch-branch sibling-count query
-- (countSiblingDraftsOnBranch / the sibling_count subquery in
-- server/store/drafts.js) now that many drafts can share one branch_name —
-- idx_drafts_site (site_id, created_at DESC) doesn't serve that lookup.
CREATE INDEX IF NOT EXISTS idx_drafts_branch_name ON drafts (site_id, branch_name) WHERE branch_name IS NOT NULL;
