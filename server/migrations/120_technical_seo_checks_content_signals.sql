-- Persists a narrow slice of page-content signals that analyzePage()
-- (server/agents/lib/page-content.js) already computes on every technical-seo
-- check but previously discarded after the run (see that table's original
-- migration 026 comment: only audit *flags*, not content, were kept). This is
-- the smallest reusable content-signal contract the Python Analyst (via a new
-- MCP read-only tool) needs to reason about content depth/thinness, without
-- persisting the full transient analyzePage() output (body text, internal
-- link hrefs, etc.) or standing up a second website-intelligence store.
--
-- All three nullable: a page not yet checked, or whose fetch failed, carries
-- no fabricated 0/'' — absence must stay visibly absent.
ALTER TABLE technical_seo_checks ADD COLUMN IF NOT EXISTS word_count INT;
ALTER TABLE technical_seo_checks ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE technical_seo_checks ADD COLUMN IF NOT EXISTS internal_link_count INT;
