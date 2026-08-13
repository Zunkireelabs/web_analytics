-- Product Understanding Layer (Phase 1 of the product-visibility growth
-- objective): structured, verifiable knowledge of what a site's OWN product
-- actually does — separate from site_profiles (079_keyword_clusters.sql),
-- which profiles topics a site already ranks for, not what it actually
-- sells. Never auto-populated as fact: 'verified' rows are human-asserted
-- ground truth (added directly with status='verified'); an agent may only
-- ever propose a 'proposed' row, which nothing downstream reads until a
-- human approves it — same pending_review -> approved gate keyword_gaps
-- already uses, not a new pattern.
CREATE TABLE IF NOT EXISTS product_capabilities (
  id             SERIAL PRIMARY KEY,
  site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  category       TEXT,
  description    TEXT,
  industries_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'proposed',
  source         TEXT NOT NULL DEFAULT 'human',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE product_capabilities DROP CONSTRAINT IF EXISTS product_capabilities_status_check;
ALTER TABLE product_capabilities ADD CONSTRAINT product_capabilities_status_check
  CHECK (status IN ('verified', 'proposed', 'rejected'));

ALTER TABLE product_capabilities DROP CONSTRAINT IF EXISTS product_capabilities_source_check;
ALTER TABLE product_capabilities ADD CONSTRAINT product_capabilities_source_check
  CHECK (source IN ('human', 'agent_proposed'));

CREATE INDEX IF NOT EXISTS idx_product_capabilities_lookup
  ON product_capabilities (site_id, status);

-- search_intent: computed once by classifyGapRelevance (analyst-seo-mapping.js)
-- at approval time, from the same real signal research_topic_keywords
-- already derives (data-analyst-agent) — this table just stops discarding
-- it. product_relevance: how the gap relates to this site's OWN verified
-- capabilities, not to what it merely ranks for. Both null until a gap is
-- approved (or otherwise classified); a null value means "not yet
-- classified," never "classified as none."
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS search_intent TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS product_relevance TEXT;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_search_intent_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_search_intent_check
  CHECK (search_intent IS NULL OR search_intent IN ('informational', 'commercial', 'transactional'));

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_product_relevance_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_product_relevance_check
  CHECK (product_relevance IS NULL OR product_relevance IN ('direct', 'supporting', 'unrelated'));
