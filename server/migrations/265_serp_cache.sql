-- Google results-page cache (lib/serp.js). The top-10 organic results, the "People Also Ask" questions and the result-page features
-- for one keyword in one market. Several features read the same results (SERP-overlap checks on keyword plans, the SERP brief for
-- blog outlines, the search-experience check on pages), each lookup is billed by DataForSEO, and a results page barely changes in
-- two weeks, so a lookup is reused for a while instead of paid for again.
--
-- Deliberately NOT per project: it holds only what Google itself shows anyone, keyed by keyword text, market and language. It says
-- nothing about which project asked. Rows older than a few weeks are never read and are removed by the next write for that key.
-- Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS serp_cache (
  keyword_key      TEXT NOT NULL,                              -- lowercased, whitespace collapsed
  location_code    INTEGER NOT NULL,                           -- DataForSEO market
  language_code    TEXT NOT NULL,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  results          JSONB NOT NULL DEFAULT '[]'::jsonb,         -- [{ position, url, domain, title, description }]
  people_also_ask  JSONB NOT NULL DEFAULT '[]'::jsonb,         -- [question]
  related_searches JSONB NOT NULL DEFAULT '[]'::jsonb,
  features         JSONB NOT NULL DEFAULT '[]'::jsonb,         -- result-page features present: featured_snippet, local_pack, shopping, video...
  PRIMARY KEY (keyword_key, location_code, language_code)
);
CREATE INDEX IF NOT EXISTS serp_cache_fetched_idx ON serp_cache (fetched_at);
