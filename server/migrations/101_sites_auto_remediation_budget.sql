-- Daily budget for the unattended auto-remediation loop
-- (agents/lib/auto-remediation.js).
--
-- Until now that loop had NO cap at all: autoRemediateSafeRecommendations
-- iterated every open safe-tier candidate for the site in one pass. That was
-- survivable only because sites.auto_remediation_enabled has been false
-- everywhere, so the loop has never actually run in production. Turning the
-- flag on without a cap would have fired every open safe recommendation at
-- once (41 of them across sites at the time of writing) — a large,
-- unreviewable burst of PRs on a customer repo the first morning it ran.
--
-- 30/day is the deliberate default: it matches the agreed target throughput,
-- and it is a CEILING rather than a goal — a steady-state site that only
-- genuinely detects a handful of new issues a day will ship a handful, not
-- 30. Per-site so a large site can be raised and a cautious pilot site can
-- be lowered without a code change.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS auto_remediation_daily_limit INTEGER NOT NULL DEFAULT 30;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_auto_remediation_daily_limit_check;
ALTER TABLE sites ADD CONSTRAINT sites_auto_remediation_daily_limit_check
  CHECK (auto_remediation_daily_limit >= 0);
