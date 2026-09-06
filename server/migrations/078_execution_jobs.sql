-- Phase 4 M3: the Execution Engine's job ledger. ONE row per bulk "Execute
-- Today's Safe Fixes" run or single-item "Approve & Ship" — never one row
-- per recommendation (see execution_job_recommendations for the per-item
-- breakdown within a job). Branch/PR mechanics are NOT reimplemented here —
-- executeSafeFixes/approveAndShipRecommendation (routes/action-center.js,
-- co-located with generateDraft/approveAndPublishDraft to avoid a circular
-- import) drive the existing generateDraft -> submitDraftForApproval ->
-- approveAndPublishDraft chain per item, which already lands same-day
-- approvals in one shared batch branch/PR (implementers/lib/github-ops.js).
-- branch_name/pr_number/pr_url here just record what that chain produced.
CREATE TABLE IF NOT EXISTS execution_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  trigger TEXT NOT NULL DEFAULT 'bulk' CHECK (trigger IN ('bulk', 'single')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'executing', 'verifying', 'completed', 'failed', 'rolled_back')),
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  requested_by INTEGER REFERENCES users(id),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  logs JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_job_recommendations (
  id SERIAL PRIMARY KEY,
  execution_job_id INTEGER NOT NULL REFERENCES execution_jobs(id),
  recommendation_id INTEGER NOT NULL REFERENCES recommendations(id),
  draft_id INTEGER REFERENCES drafts(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'drafted', 'submitted', 'approved', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_job_recommendations_job_idx ON execution_job_recommendations (execution_job_id);

-- Migration 077 reserved execution_job_id and verification_status on
-- recommendations for later milestones but missed execution_status
-- (queued/drafted/shipped/failed, set by the chain above) — adding it here
-- since this is the migration that actually starts writing to it.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS execution_status TEXT;

-- Backfill risk_tier for every recommendation row inserted by M1 before this
-- migration existed (they all defaulted to 'manual'). Mirrors
-- agents/lib/risk-tiers.js's SAFE_GENERATOR_IDS exactly — keep these two in
-- sync if the safe list ever changes.
--
-- This directory has NO migration-tracking table: run.js applies every .sql
-- file on every deploy (see 100_recommendations_design_blocked.sql for the
-- full explanation). So a data statement here is not a one-time backfill —
-- it re-executes forever, against rows written long after it was authored.
-- It must therefore be written to CONVERGE on the current invariant, not to
-- restate the invariant as it stood the day it was written.
--
-- That is exactly how this statement corrupted live data. It predates
-- blocked_reason (added in migration 100), so it knew nothing about it, and
-- every deploy promoted open-but-blocked rows of these types back to 'safe'
-- — manufacturing the contradictory safe+blocked state that the unattended
-- shipping loop then had to defend against. The guards below restore the
-- invariant "blocked_reason IS NOT NULL => risk_tier = 'manual'", which
-- migration 108 also enforces structurally as a CHECK constraint. If you add
-- a data statement to this directory, guard it the same way.
-- The guard has to be applied dynamically, because this file sorts BEFORE the
-- migration that creates the column it guards on (100). Two real orderings:
--   - fresh database: 077b just created an empty recommendations table, so
--     there is nothing to backfill and skipping is correct;
--   - existing database mid-upgrade to 100: rows exist but blocked_reason
--     does not yet, and those rows were already backfilled by this same
--     statement on every previous deploy, so skipping is correct there too.
-- Every deploy after 100 has the column and takes the guarded path.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recommendations' AND column_name = 'blocked_reason'
  ) THEN
    UPDATE recommendations SET risk_tier = 'safe'
    WHERE recommendation_type IN (
      'meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap',
      'robots-fix', 'security-headers', 'html-lang', 'canonical', 'viewport',
      'open-graph', 'expand-content', 'blog-outline'
    ) AND risk_tier != 'safe'
      AND status = 'open'
      AND blocked_reason IS NULL;
  END IF;
END $$;
