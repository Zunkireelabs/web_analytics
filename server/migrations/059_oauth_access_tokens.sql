-- OAuth-issued access tokens. Deliberately a separate table from api_tokens
-- (054) rather than a shared one with a "kind" column — different lifecycle
-- (short TTL, tied to a registered oauth_clients row, part of a refresh
-- chain) and different issuance path (never user-typed, never shown raw in
-- any settings UI). Kept structurally close to api_tokens so
-- requireMcpToken's contract (site_id/permission_level/token id) is
-- trivially satisfied from either table — see server/mcp/auth.js.
--
-- permission_level is copied verbatim from the authorization code (or
-- re-clamped from the prior refresh token) at mint time — never taken from a
-- request parameter at this table's write site. 'admin' is not a legal value.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id                  SERIAL PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_level    TEXT NOT NULL DEFAULT 'read_only'
    CHECK (permission_level IN ('read_only', 'ai_actions', 'automation')),
  scope               TEXT,
  resource            TEXT,
  refresh_family_id   UUID,               -- the oauth_refresh_tokens.family_id this token was minted alongside, so reuse detection can revoke every access token from a compromised chain in one query
  expires_at          TIMESTAMPTZ NOT NULL,
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_hash ON oauth_access_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_site ON oauth_access_tokens (site_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_refresh_family ON oauth_access_tokens (refresh_family_id) WHERE refresh_family_id IS NOT NULL;
