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
UPDATE recommendations SET risk_tier = 'safe'
WHERE recommendation_type IN (
  'meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap',
  'robots-fix', 'security-headers', 'html-lang', 'canonical', 'viewport',
  'open-graph', 'expand-content', 'blog-outline'
) AND risk_tier != 'safe';
