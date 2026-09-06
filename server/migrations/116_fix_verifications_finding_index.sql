-- getImplementedFindingIds (server/store/drafts.js) now LATERAL-joins
-- fix_verifications by (site_id, finding_id) on every call — job.js's daily
-- health-score run, command-center.js, growth-report.js, growth-summary.js —
-- to exclude a finding whose most recent real re-check still found the issue
-- live, even though its draft says 'implemented'. Without this index that
-- join falls back to a per-call sequential scan.
CREATE INDEX IF NOT EXISTS idx_fix_verifications_site_finding
  ON fix_verifications (site_id, finding_id, checked_at DESC);
