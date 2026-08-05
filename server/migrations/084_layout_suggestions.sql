CREATE TABLE IF NOT EXISTS layout_suggestions (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  layout_json JSONB NOT NULL,
  reason TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_layout_suggestions_lookup
ON layout_suggestions (site_id, generated_at DESC);
