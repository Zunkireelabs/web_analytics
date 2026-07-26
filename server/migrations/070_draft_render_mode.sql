-- Which render mode ('visible' | 'schema-only') was actually applied for
-- this draft, set once a real GitHub branch push succeeds (markDraftBranch-
-- Pushed) — mirrors branch_name/implementer_id, which are also only set at
-- that point. Exists so countVisibleFaqDrafts (server/store/drafts.js) can
-- count how many pages on a site already carry a visible FAQ block, feeding
-- the sitewide visible-FAQ cap in render-inspector.js. Nullable/purely
-- additive; meaningless (always 'visible') for non-FAQ action types, since
-- only 'faq' has more than one representation (see render-inspector.js's
-- INSPECTABLE_ACTION_TYPES).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS render_mode TEXT;
