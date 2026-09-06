-- Daily snapshot of the composite Website Health score (see
-- agents/lib/health-score.js), so the AI Command Center can show a real
-- trend ("+3 this week") instead of only today's number. Reuses
-- daily_reports (already one row per site per day) rather than a new table.
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS website_health_score INTEGER;
