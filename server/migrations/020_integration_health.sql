-- General integration health tracking — Google OAuth is the first registered
-- integration, but this table is designed so adding Search Console, GA4,
-- Docs, DataForSEO, OpenAI, Anthropic, email, or any future API is just a
-- new integration_id value, never a schema change. site_id is nullable
-- because most integrations today are shared/system-wide (one refresh token
-- for every client) rather than per-site.
CREATE TABLE IF NOT EXISTS integration_health (
  id SERIAL PRIMARY KEY,
  integration_id TEXT NOT NULL,
  site_id INTEGER REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'unknown',   -- 'ok' | 'error' | 'unknown'
  auth_status TEXT,                          -- 'valid' | 'expired' | 'revoked' | 'not_configured' | NULL
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  error_message TEXT,                        -- internal-only diagnostic detail
  recovery_action TEXT,                      -- human-readable suggested fix
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (integration, site) — COALESCE lets NULL site_id (system-wide
-- integrations) collapse to a single slot instead of allowing duplicates,
-- without depending on Postgres 15's UNIQUE NULLS NOT DISTINCT syntax.
CREATE UNIQUE INDEX IF NOT EXISTS integration_health_unique
  ON integration_health (integration_id, COALESCE(site_id, -1));
