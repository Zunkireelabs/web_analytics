-- How a site's daily fixes reach its repository.
--
--   'auto'          the default and today's behaviour: the daily run drafts, approves and pushes the fixes itself, and a person
--                   merges the pull request (to stage first when the site has a stage branch).
--   'review-first'  the daily run still drafts up to its daily limit, but stops there. Nothing is submitted, approved, committed
--                   or pushed until the client has reviewed the drafts and said so in the dashboard (lib/ship-flow.js then asks
--                   "put the approved fixes on today's branch as ONE commit?", then "open the PR?", and so on). Used for clients
--                   who want to approve every change themselves.
--
-- Plain ADD COLUMN with a constant default: no table rewrite and no UPDATE over `sites`. Which sites are review-first is a
-- per-client decision made by a person, never set by this migration.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS ship_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_ship_mode_check;
ALTER TABLE sites ADD CONSTRAINT sites_ship_mode_check CHECK (ship_mode IN ('auto', 'review-first'));
