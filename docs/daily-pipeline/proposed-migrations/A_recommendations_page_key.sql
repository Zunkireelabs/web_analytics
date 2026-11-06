-- PROPOSED, not applied. The canonical page key, stored beside the page text it is computed from (never instead of it).
-- Nullable and unread at first: writers fill it behind CANONICAL_PAGE_KEY_WRITE; readers switch to it only behind
-- CANONICAL_PAGE_KEY_READ, falling back to `page` for any row without one. Additive and idempotent; no data statements.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS page_key TEXT;
