-- Per-tenant GitHub credentials without a per-tenant secret.
--
-- Today each site authenticates with a PAT named by sites.github_pat_env_var.
-- That works and is genuinely isolated, but it does not scale past a client or
-- two, for three reasons found the hard way:
--   1. A new tenant needs a new env var, which needs a new Actions secret AND a
--      new line in deploy-staging.yml AND a redeploy — a code change per
--      customer, which is exactly what the product goal says must not be needed.
--   2. Every PAT expires, on a date we do not control because it lives in the
--      client's own GitHub account. Site 1's lapsed on 2026-08-12 and the
--      autonomous chain stopped opening PRs for two days before anyone noticed.
--   3. It asks a client to hand over a long-lived credential to their
--      production website. Some will refuse, and they are right to.
--
-- A GitHub App installation removes all three: the client clicks Install on
-- their own repo, no credential changes hands, and tokens are minted per
-- installation and expire in an hour, so there is nothing to store or renew.
-- This column holds the installation id GitHub assigns when they do that.
--
-- NULL means "this site still uses its PAT", which is every existing site and
-- stays a fully supported path — see server/github/credentials.js for the
-- precedence rule. Nothing here migrates or breaks an existing tenant.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS github_app_installation_id BIGINT;

COMMENT ON COLUMN sites.github_app_installation_id IS
  'GitHub App installation id for this tenant''s repo. NULL = authenticate with the PAT named by github_pat_env_var instead.';
