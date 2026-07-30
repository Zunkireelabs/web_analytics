-- Sitewide count of pages that ALREADY had a visible on-page FAQ before this
-- tool ever ran (organic, hand-built FAQs — never touched by an approved
-- draft). visible_faq_cap (migration 071) only becomes a true sitewide
-- ceiling once it's checked against baseline + tool-injected count together
-- — countVisibleFaqDrafts (server/store/drafts.js) alone only sees FAQs this
-- tool itself published, so without this a site with existing organic FAQs
-- could end up with more than visible_faq_cap visible FAQ pages overall.
--
-- Computed once via a staff-triggered "Recalculate FAQ baseline" action
-- (server/routes/clients.js), not on every apply — cheap to read, and stays
-- correct until pages change outside this tool, at which point staff
-- re-triggers the same action rather than this being scanned live per draft.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS visible_faq_baseline INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_visible_faq_baseline_check;
ALTER TABLE sites ADD CONSTRAINT sites_visible_faq_baseline_check
  CHECK (visible_faq_baseline >= 0);
