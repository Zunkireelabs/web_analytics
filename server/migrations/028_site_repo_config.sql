-- GitHub repo config for the Action Center's "apply approved draft as a real
-- PR" flow (server/implementers/). Nullable/defaulted so every existing site
-- (and any future client site) works unchanged with no repo configured —
-- Action Center features that don't need a repo (generate/edit/approve) are
-- entirely unaffected. Populated once via `npm run connect-repo`, the same
-- one-time-setup convention connect-site.js already uses for GSC/GA4,
-- rather than re-given per draft.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS repo_owner TEXT;              -- GitHub org/user, e.g. 'zunkiree-labs'
ALTER TABLE sites ADD COLUMN IF NOT EXISTS repo_name TEXT;               -- e.g. 'zunkireelabs-site'
ALTER TABLE sites ADD COLUMN IF NOT EXISTS repo_url TEXT;                -- display-only convenience, like website_domain vs gsc_property (migration 011)
ALTER TABLE sites ADD COLUMN IF NOT EXISTS repo_default_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS tech_stack TEXT;              -- free-text identifier ('astro' | 'nextjs' | 'hugo' | ...) — not enum-constrained with only one pilot site
-- Which env var holds this site's GitHub PAT — defaults to a single shared
-- var today (one pilot site), but per-site indirection means onboarding a
-- second repo later is a config change, not a code change.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS github_pat_env_var TEXT NOT NULL DEFAULT 'GITHUB_PAT';
-- Explicit URL->file mapping + new-content targets (server/implementers/lib/url-file-map.js
-- resolves against this; never guesses a path). Same "structured config blob
-- on the row" idiom drafts.content already uses. Empty by default — every
-- apply() call honestly fails with reason:'no-file-mapping' until populated.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS url_file_map JSONB NOT NULL DEFAULT '{}'::jsonb;
