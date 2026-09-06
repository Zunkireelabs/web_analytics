-- Short-lived, single-use authorization codes with mandatory PKCE (S256 only
-- — see the CHECK below and server/mcp/oauth-provider.js). Same hashing
-- philosophy as api_tokens (054): the raw code is high-entropy and
-- unguessable, so it's stored as a SHA-256 hash, never bcrypt'd.
--
-- permission_level here is always computed server-side at issuance time from
-- sites.oauth_max_permission_level (migration 061) intersected with the
-- OAuth client's requested scope — it is never populated from a client- or
-- browser-supplied "permissionLevel" field. See server/routes/oauth-consent.js.
-- 'admin' is deliberately not a legal value — OAuth can never reach that tier.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                     SERIAL PRIMARY KEY,
  code_hash              TEXT NOT NULL UNIQUE,
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  site_id                INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id                INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri           TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  scope                  TEXT,
  permission_level       TEXT NOT NULL DEFAULT 'read_only'
    CHECK (permission_level IN ('read_only', 'ai_actions', 'automation')),
  resource                TEXT,
  expires_at              TIMESTAMPTZ NOT NULL,
  used_at                 TIMESTAMPTZ,           -- set on first (and only allowed) exchange — replay guard
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_hash ON oauth_authorization_codes (code_hash) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_codes_site ON oauth_authorization_codes (site_id);
