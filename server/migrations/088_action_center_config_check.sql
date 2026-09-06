-- Persists the result of audit-url-file-map.js's config-completeness check
-- (url_file_map + live SEOAI:<name> markers) directly on the site row, so
-- "has anyone actually verified this site's Action Center config is clean"
-- is a queryable fact instead of living only in whoever last ran the script's
-- terminal scrollback. Read by integrations/github.js's Integration Health
-- check to surface a nudge when a repo is connected but never audited.
--
-- Nullable/defaulted so every existing site works unchanged: NULL means
-- "never checked," not "broken" — the same non-alarming-by-default idiom
-- migration 028 used for repo_owner/repo_name.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS action_center_config_checked_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS action_center_config_gap_count INTEGER;

-- Backfill: any site that already has a repo AND a populated url_file_map is
-- presumably already working today (drafts have been applying fine) — mark
-- it checked/clean now rather than surfacing a false "never audited" nudge
-- for integrations that predate this column. Only sites onboarded from here
-- on get their checked_at/gap_count from a real audit run.
UPDATE sites
SET action_center_config_checked_at = now(), action_center_config_gap_count = 0
WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL
  AND url_file_map IS NOT NULL AND url_file_map != '{}'::jsonb
  AND action_center_config_checked_at IS NULL;
