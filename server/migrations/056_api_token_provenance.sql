-- Tracks which token (if any) minted a given token via the MCP
-- `create_api_token` admin tool. `admin`-tier tokens can mint more tokens —
-- including more `admin` tokens — with no human confirming each one (by
-- design, see server/mcp/tools/admin.js). There's no session/user id to
-- attribute an MCP-created token to (created_by stays NULL for those, same
-- as before), so this is the only trail back to "which token created this
-- one" if a compromised admin token is used to self-replicate access.
-- NULL for every token created the normal way (self-serve, session-authed,
-- via server/routes/mcp-tokens.js) — those aren't created "via" another
-- token at all.
ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS created_via_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_tokens_created_via ON api_tokens (created_via_token_id) WHERE created_via_token_id IS NOT NULL;
