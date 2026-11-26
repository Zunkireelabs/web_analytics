-- THREE SEPARATE FACTS about a change, so none can be mistaken for another:
--   pr_opened            the pull request exists (already recorded: pr_number / pr_url / pr_state = 'open')
--   human_merged         a PERSON merged it on GitHub. Recorded from GitHub's own merged_by, never inferred: merged_by is the login, merged_by_type is GitHub's
--                        account type ('User' for a person, 'Bot' for an app). A merge by a Bot is an anomaly: this system never merges, and the alerts say so.
--   production_verified  the fix-verification job re-read the LIVE page and found the change there (fix_verifications.outcome = 'verified-fixed')
-- Before this, "implemented" meant "GitHub says merged": it said nothing about who merged it or whether the change ever reached the live site.
--
-- Additive and idempotent, like every file here; no data statements.

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS merged_by TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS merged_by_type TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS production_verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS drafts_merge_state_idx ON drafts (site_id, merged_at, production_verified_at) WHERE pr_number IS NOT NULL;
