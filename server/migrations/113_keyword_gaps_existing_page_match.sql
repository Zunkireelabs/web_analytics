-- Existing-page-similarity check (product-visibility growth objective,
-- Phase 3): findExistingPageMatch (server/agents/lib/analyst-seo-mapping.js)
-- checks a gap's topic against the site's real page_inventory (027) before
-- treating it as a true content gap. NULL means "no match found or not yet
-- checked" — a real URL means an existing page already substantially covers
-- this topic, which is what lets gapDraftEligibility return "no action"
-- instead of drafting a near-duplicate page.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS existing_page_match TEXT;
