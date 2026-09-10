-- A per-client GitHub App, so each tenant's shipping run draws against its
-- own rate-limit budget instead of all of them sharing one.
--
-- Migration 106 gave every site its own installation id, but installation ids
-- are children of a single App registration — every site still authenticated
-- as the SAME App (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_B64), so they all
-- shared that one App's 5,000/hr GitHub API budget. That was invisible with
-- one tenant; with two (sites 1 and 8862, both under the Zunkireelabs GitHub
-- account, both pointed at installation 153416356) it meant a heavy shipping
-- day for one tenant silently rate-limited the other's PRs into "abandoned".
--
-- These columns let a site declare its OWN App registration instead of the
-- shared default:
--   github_app_id                 — that App's id (GitHub assigns one per
--                                    App registration, distinct from the
--                                    installation id).
--   github_app_private_key_env_var — the env var holding that App's base64
--                                    private key, e.g. GITHUB_APP_PRIVATE_KEY_B64_ADMIZZ.
--                                    Named like github_pat_env_var (migration
--                                    028) on purpose: the key material lives
--                                    in env, never in this table.
--
-- NULL in github_app_id means "use the shared default App" — every existing
-- site, unchanged. A site only needs both new columns once it has its own
-- registered App; setting github_app_installation_id alone (as before)
-- keeps meaning "authenticate as the default App's installation on this repo".

ALTER TABLE sites ADD COLUMN IF NOT EXISTS github_app_id BIGINT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS github_app_private_key_env_var TEXT;

COMMENT ON COLUMN sites.github_app_id IS
  'This tenant''s own registered GitHub App id. NULL = authenticate as the shared default App (GITHUB_APP_ID) instead.';
COMMENT ON COLUMN sites.github_app_private_key_env_var IS
  'Env var holding this tenant''s own App''s base64 private key. Only meaningful when github_app_id is set.';
