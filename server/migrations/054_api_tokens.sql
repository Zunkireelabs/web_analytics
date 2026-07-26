-- Bearer tokens for the read-only analytics MCP endpoint (POST /api/mcp).
-- One token maps to exactly one site, same isolation model as session auth
-- (requireAuth in server/routes/login.js). No scope/role column yet on
-- purpose: every token today can only reach read-only Tier 1 tools (see
-- server/mcp/tools.js), so there is nothing to gate. A future migration
-- will add whatever column the eventual permission model needs once it's
-- defined — this table is intentionally left extensible, not pre-guessed.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           SERIAL PRIMARY KEY,
  site_id      INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL, -- first 8 chars of the raw token, shown in the UI so a token can be told apart without re-displaying the secret
  label        TEXT,
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_site ON api_tokens (site_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash) WHERE revoked_at IS NULL;
