-- Narrows growth_targets.metric to match GROWTH_TARGET_METRICS
-- (server/agents/lib/growth-report.js), now that health_score, clicks,
-- competitor_readiness, authority_score, and ai_recommendation_rate are all
-- retired from manual targeting in favor of AI-computed projections
-- (server/agents/lib/growth-projection.js). Safe to narrow directly: the
-- table has zero rows for any of the retired metrics (confirmed before
-- writing this migration).
ALTER TABLE growth_targets DROP CONSTRAINT IF EXISTS growth_targets_metric_check;
ALTER TABLE growth_targets ADD CONSTRAINT growth_targets_metric_check CHECK (metric IN ('impressions', 'ctr'));
