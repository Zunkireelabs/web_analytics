-- SRANK-47: the baseline now detects a project's industry itself.
--
-- 'detected' = two independent signals agreed (see server/lib/industry-detect.js). It is its own source so a detection
-- can be told apart from a person's choice ('human') and is never allowed to overwrite one.
-- industry_signals keeps what each signal said, so "why this industry" can be shown and re-checked later.
-- Additive and idempotent.
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS industry_signals JSONB;
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS industry_checked_at TIMESTAMPTZ;

ALTER TABLE site_profiles DROP CONSTRAINT IF EXISTS site_profiles_industry_source_check;
ALTER TABLE site_profiles ADD CONSTRAINT site_profiles_industry_source_check
  CHECK (industry_source IS NULL OR industry_source IN ('human', 'growth-config', 'llm-classified', 'inferred', 'unmapped', 'detected'));
