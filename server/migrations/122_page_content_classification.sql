-- Per-page content-type classification (product/service/blog/landing/faq/
-- category/legal/other) — the third applicability layer for cross-client
-- learned repair, alongside the technical/structural signals already in
-- site-fingerprint.js (render:/target-ext:/page-adapter:). A repair proven
-- technically and structurally compatible can still be nonsense to reuse if
-- the target page is a different KIND of page than the one it was proven on
-- (a FAQ-tone fix learned on a blog page has no business running on a
-- product page). This table is that missing signal.
--
-- Strictly PER-TENANT — never a cross-tenant row. Only a bare enum value
-- (e.g. 'content-type:blog') is ever read out of here and pushed into
-- site-fingerprint.js's token array, which IS what crosses into the
-- cross-tenant agent_fix_memory.site_fingerprint column — same privacy
-- shape already established for render:/page-adapter:, never a page URL or
-- any client-identifying text.
CREATE TABLE IF NOT EXISTS page_content_classification (
  id             SERIAL PRIMARY KEY,
  site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page           TEXT NOT NULL,
  content_type   TEXT NOT NULL CHECK (content_type IN (
                   'product', 'service', 'blog', 'landing', 'faq', 'category', 'legal', 'other'
                 )),
  -- 0.00-1.00. Below the caller's confidence floor, a classification is
  -- treated as absent rather than trusted — see page-content-classifier.js.
  confidence     NUMERIC(3, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  classified_by  TEXT NOT NULL, -- 'path-heuristic' | 'llm'
  classified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, page)
);

CREATE INDEX IF NOT EXISTS idx_page_content_classification_site ON page_content_classification (site_id);
