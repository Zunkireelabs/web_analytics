-- Refresh tokens with rotate-on-use + reuse detection. Each refresh exchange
-- issues a brand-new row and marks the old one both consumed (used_at) AND
-- linked forward (rotated_to_id), so a replayed *old* refresh token can be
-- told apart from "never used yet" — and the whole chain (family_id), plus
-- every access token minted from it, can be revoked on reuse. See
-- exchangeRefreshToken in server/mcp/oauth-provider.js.
--
-- permission_level is re-clamped against the site's current
-- oauth_max_permission_level on every rotation, never re-derived from the
-- refresh request itself. 'admin' is not a legal value.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id                 SERIAL PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  site_id            INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_level   TEXT NOT NULL DEFAULT 'read_only'
    CHECK (permission_level IN ('read_only', 'ai_actions', 'automation')),
  scope              TEXT,
  resource           TEXT,
  family_id          UUID NOT NULL,       -- constant across a rotation chain — the unit revoked on reuse detection
  rotated_to_id      INTEGER REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  used_at            TIMESTAMPTZ,         -- set the instant this token is exchanged (rotated away)
  revoked_at         TIMESTAMPTZ,         -- set on logout/explicit revoke/reuse-detected family kill
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_hash ON oauth_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens (family_id);
