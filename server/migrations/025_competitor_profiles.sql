-- LLM-discovered competitors for a site and the structured comparison
-- against each — the "detect competitors -> crawl -> compare" pipeline
-- (server/agents/lib/competitor-analysis.js) that competitor-intelligence
-- runs on every site regardless of whether a real SERP provider
-- (DataForSEO/Ahrefs/Semrush, see ingest/competitor-providers/) is
-- configured. Real provider data, when available, enriches these findings
-- (keyword-level rankings) rather than replacing this — see
-- competitor_rankings (migration 018) for that data.
CREATE TABLE IF NOT EXISTS competitor_profiles (
  id                 SERIAL PRIMARY KEY,
  site_id            INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain             TEXT NOT NULL,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_analyzed_at   TIMESTAMPTZ,
  comparison         JSONB,   -- structured: positioning, contentDepth, seoStructure, aiVisibility, schema, faq, landingPages
  UNIQUE (site_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_competitor_profiles_site ON competitor_profiles (site_id, last_analyzed_at DESC);
