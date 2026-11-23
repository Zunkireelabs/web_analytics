-- SEO drift monitor (agents/seo-drift.js). One row per capture of a page's SEO-critical elements, so a later capture can be
-- compared with the page's "known good" baseline and a silent regression (title wiped, canonical changed, noindex added, schema
-- removed, page now 404) is caught the day it happens, whoever caused it.
--
--   baseline = the capture a page is compared against. Exactly one per (site, url), enforced below.
--     'first-capture'  the first time the page was seen
--     'own-change'     moved forward after a fix WE shipped on that page changed it on purpose
--     'accepted'       moved forward because a person said "this change is intended"
--
-- Only the elements that matter to search are kept, plus two hashes (structured data, normalized visible text). No page HTML is
-- stored. Non-baseline captures are pruned by the agent to the most recent 30 per page.
-- Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS seo_page_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_code      INTEGER,
  title            TEXT,
  meta_description TEXT,
  canonical        TEXT,
  robots           TEXT,                                 -- meta robots + googlebot + X-Robots-Tag, lowercased, sorted, comma-joined
  h1               JSONB NOT NULL DEFAULT '[]'::jsonb,
  h2               JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_types     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON-LD @type values
  schema_hash      TEXT,
  open_graph       JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash     TEXT,                                 -- of normalized visible text (digits masked), not of raw HTML
  word_count       INTEGER,
  is_baseline      BOOLEAN NOT NULL DEFAULT false,
  baseline_reason  TEXT CHECK (baseline_reason IS NULL OR baseline_reason IN ('first-capture', 'own-change', 'accepted'))
);

CREATE INDEX IF NOT EXISTS seo_page_snapshots_page_idx ON seo_page_snapshots (site_id, url, captured_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS seo_page_snapshots_one_baseline ON seo_page_snapshots (site_id, url) WHERE is_baseline;
