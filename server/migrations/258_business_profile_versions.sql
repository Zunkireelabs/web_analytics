-- Canonical business profile: ONE evidence-backed, versioned description of what a project's business is, shared by every agent
-- (lib/business-profile.js defines the content; lib/tenant-context.js serves it; store/business-profile.js reads and writes this table).
--
-- PREPARED FOR REVIEW. Do not apply to production before the owner approves it. Nothing in the code depends on this table existing:
-- while it is absent every reader treats a project as "no canonical profile yet" and behaves exactly as before.
--
-- Why a new table at all: no existing structure stores profile CONTENT with history. project_memory_log keeps only a hash and a
-- digest, so it cannot restore a previous profile. site_profiles holds one current coarse label (industry, topics, site_type) and
-- stays as a derived, compatibility copy. site_understanding holds repository and technology findings, not business facts.
--
-- Append-only: a change to the profile (a new detection, a person's confirmation, an edit) is a NEW row. Nothing is updated or deleted,
-- so the full change history, who made each change, and the evidence behind it are always available.
--
-- Isolation: every row belongs to exactly one project (site_id) and every query filters on it. RLS is enabled like every other public
-- table (migration 225); the app role bypasses it, so isolation is enforced in the store functions and tested there.

CREATE TABLE IF NOT EXISTS business_profile_versions (
  id             BIGSERIAL   PRIMARY KEY,
  site_id        INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version        INTEGER     NOT NULL CHECK (version >= 1),
  -- The overall state of the profile at this version (lib/business-profile.js profileState).
  status         TEXT        NOT NULL CHECK (status IN ('insufficient', 'unverified', 'detected', 'partially-confirmed', 'confirmed')),
  -- The full profile: per field value, status (confirmed/detected/assumed/insufficient), confidence, evidence[], verifiedAt/By.
  profile        JSONB       NOT NULL,
  content_hash   TEXT        NOT NULL,
  -- changed: fields this version changed; pending: automated findings that DIFFER from a confirmed field and await a person's review;
  -- applied: a person's review actions; usage: model calls and tokens spent producing it.
  change_summary JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source         TEXT        NOT NULL CHECK (source IN ('system', 'human', 'import')),
  actor          TEXT,
  reason         TEXT        NOT NULL CHECK (reason IN ('baseline', 'weekly', 'refresh', 'onboarding', 'review', 'import')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, version)
);

CREATE INDEX IF NOT EXISTS business_profile_versions_latest_idx ON business_profile_versions (site_id, version DESC);

ALTER TABLE business_profile_versions ENABLE ROW LEVEL SECURITY;

-- Rollback (reviewed manually, not run automatically): DROP TABLE IF EXISTS business_profile_versions;
