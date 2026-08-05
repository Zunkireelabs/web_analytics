-- Keyword Clustering: groups semantically-similar GSC queries (gsc_breakdown,
-- dim_type='query') into topic clusters via sentence-transformers embeddings,
-- named/typed by Claude (agents/clustering.py Step 2). Standalone script, no
-- relation to server/agents/growth-queries.js or server/agents/opportunity.js
-- — no shared table, no shared code, reads gsc_breakdown directly.
--
-- Append-only per run, same convention as forecast_runs/anomalies elsewhere
-- in this schema: each run (every 14 days) inserts a fresh snapshot rather
-- than overwriting the previous one. Callers should read the latest run per
-- site via MAX(created_at), not assume one row per site.
CREATE TABLE IF NOT EXISTS keyword_clusters (
  id              SERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cluster_name    TEXT NOT NULL,        -- Claude-assigned, from the cluster's real keywords
  cluster_type    TEXT NOT NULL DEFAULT 'general',
  keywords_json   JSONB NOT NULL,       -- [{keyword, impressions, avg_position}, ...]
  avg_impressions NUMERIC(12,2) NOT NULL,
  avg_position    NUMERIC(6,2),         -- impression-weighted across the cluster's keywords; null if no position data
  gap_score       NUMERIC(12,2) NOT NULL DEFAULT 0,  -- avg_impressions when avg_position > 20 AND avg_impressions > 50, else 0
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE keyword_clusters DROP CONSTRAINT IF EXISTS keyword_clusters_type_check;
ALTER TABLE keyword_clusters ADD CONSTRAINT keyword_clusters_type_check
  CHECK (cluster_type IN ('service', 'product', 'general'));

CREATE INDEX IF NOT EXISTS idx_keyword_clusters_lookup ON keyword_clusters (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyword_clusters_type ON keyword_clusters (site_id, cluster_type);
