-- Sitewide ceiling on how many pages may get a visible on-page FAQ block —
-- visible FAQs are meant to stay selective (only the pages that actually
-- need one), everything else publishes FAQPage structured data only. Read
-- by render-inspector.js's inspectRenderMode via countVisibleFaqDrafts
-- (server/store/drafts.js) against drafts.render_mode. Staff-editable via
-- the internal /internal/clients surface (server/routes/clients.js), same
-- pattern as oauth_max_permission_level (migration 061).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS visible_faq_cap INTEGER NOT NULL DEFAULT 5;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_visible_faq_cap_check;
ALTER TABLE sites ADD CONSTRAINT sites_visible_faq_cap_check
  CHECK (visible_faq_cap >= 0);
