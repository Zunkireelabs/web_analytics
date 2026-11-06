-- Phase 1 (project memory): an append-only version log for each project's memory.
--
-- Project memory itself is NOT stored here. It is composed on read from the tables that already hold each fact
-- (site_understanding, site_profiles, site_goals, the design profile in sites.url_file_map, competitor_profiles,
-- baseline_reports, drafts, fix_impact, deployments), so there is no second copy to drift. This table records only WHEN
-- a section's content changed and what it looked like in summary: a version number, a content hash and a small digest.
-- It deliberately does not keep a full snapshot (a design profile alone is 130-180 KB per capture).
--
-- One row per (site, section, version). A new version is written only when the section's content hash differs from the
-- latest one, so an unchanged project adds nothing day after day.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS project_memory_log (
  id           BIGSERIAL   PRIMARY KEY,
  site_id      INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  section      TEXT        NOT NULL CHECK (section IN ('business', 'technical', 'design', 'search', 'history')),
  version      INTEGER     NOT NULL CHECK (version >= 1),
  content_hash TEXT        NOT NULL,
  digest       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  provenance   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason       TEXT        NOT NULL DEFAULT 'manual' CHECK (reason IN ('onboarding', 'cron', 'manual')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, section, version)
);
CREATE INDEX IF NOT EXISTS project_memory_log_latest_idx ON project_memory_log (site_id, section, version DESC);

-- Same state as every other table in this schema (see 225): RLS on, no policies; the app connects as a role that bypasses it.
ALTER TABLE project_memory_log ENABLE ROW LEVEL SECURITY;
