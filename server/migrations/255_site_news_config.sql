-- Per-project settings for news-based blog posts (agents/news-posts.js): which official sites a news lead must be confirmed
-- on, which feeds to read for leads, how often to look, and the client's own writing rules. One row per project; a project
-- with no row, or enabled = false, is never touched. Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS site_news_config (
  site_id          INT         PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  enabled          BOOLEAN     NOT NULL DEFAULT false,
  interval_days    INT         NOT NULL DEFAULT 7 CHECK (interval_days BETWEEN 1 AND 60),
  official_sources JSONB       NOT NULL DEFAULT '[]'::jsonb,
  lead_feeds       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  style_rules      TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE site_news_config ENABLE ROW LEVEL SECURITY;
