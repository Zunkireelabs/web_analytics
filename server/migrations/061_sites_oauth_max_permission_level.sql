-- The trusted, server-side ceiling on what any OAuth-issued MCP token can
-- reach for this site. Set only by Zunkiree staff via the internal
-- /internal/clients surface (server/routes/clients.js, requireInternalSite-
-- gated) — same pattern as every other staff-managed site config column
-- (repo_owner, tech_stack, github_pat_env_var, url_file_map, etc., see
-- migrations 011-049). Never readable or writable from a client-facing
-- route. The OAuth consent flow (server/routes/oauth-consent.js) and token
-- exchange (server/mcp/oauth-provider.js) read this value to compute the
-- effective permission_level for a grant — a client's requested `scope` can
-- only narrow it, never raise it.
--
-- 'admin' is deliberately not a legal value here: OAuth tokens must never be
-- able to reach the tier that can mint/revoke other tokens (server/mcp/
-- tools/admin.js) unattended. Internal devs who need admin still use the
-- untouched manual token flow (server/routes/mcp-tokens.js).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS oauth_max_permission_level TEXT NOT NULL DEFAULT 'read_only';

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_oauth_max_permission_level_check;
ALTER TABLE sites ADD CONSTRAINT sites_oauth_max_permission_level_check
  CHECK (oauth_max_permission_level IN ('read_only', 'ai_actions', 'automation'));
