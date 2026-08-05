-- Claude's current understanding of each site — industry, main topics,
-- site_type — inferred from its own real top search queries
-- (agents/clustering.py Step 1). Current-state row per site, upserted in
-- place each run (not append-only): consumers want "what is this site"
-- right now, not a history of past guesses. profiled_at tracks freshness.
CREATE TABLE IF NOT EXISTS site_profiles (
  site_id          INT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  industry         TEXT,
  main_topics_json JSONB,
  site_type        TEXT,
  profiled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE site_profiles DROP CONSTRAINT IF EXISTS site_profiles_site_type_check;
ALTER TABLE site_profiles ADD CONSTRAINT site_profiles_site_type_check
  CHECK (site_type IS NULL OR site_type IN ('service', 'product', 'ecommerce', 'education'));
