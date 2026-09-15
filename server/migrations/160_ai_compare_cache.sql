-- Caches the AI action-plan narrative behind metrics.js's /ai-compare and
-- /ai-compare-range so a page revisit or repeat click doesn't spend a fresh
-- OpenAI call when the underlying month/range totals haven't changed since
-- the last generation (same staleness-signature pattern as layout_suggestions,
-- migration 084).
CREATE TABLE IF NOT EXISTS ai_compare_cache (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  compare_type TEXT NOT NULL, -- 'month' or 'range'
  params_key TEXT NOT NULL,   -- e.g. '2026-08|2026-09' or '2026-08-01|2026-08-31|2026-09-01|2026-09-30'
  data_signature JSONB NOT NULL, -- { a, b, vsAtoBPct } as last computed, for staleness comparison
  plan TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, compare_type, params_key)
);
