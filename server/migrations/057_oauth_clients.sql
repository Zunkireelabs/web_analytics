-- RFC 7591 Dynamic Client Registration store. Claude.ai / ChatGPT self-register
-- the first time a user clicks "Connect" from that AI client — no manual
-- client_id provisioning, unlike api_tokens (054) which never needed a
-- distinct "client" concept at all since the caller was just a bearer secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                          SERIAL PRIMARY KEY,
  client_id                   TEXT NOT NULL UNIQUE,
  client_secret_hash          TEXT,               -- NULL for public clients (token_endpoint_auth_method='none'), the expected case for AI connectors
  client_name                 TEXT,
  logo_uri                    TEXT,
  redirect_uris               TEXT[] NOT NULL,
  token_endpoint_auth_method  TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post')),
  grant_types                 TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  client_secret_expires_at    TIMESTAMPTZ,        -- NULL = never expires (confidential clients only; unused while client_secret_hash is always NULL)
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients (client_id);
