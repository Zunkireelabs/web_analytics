-- Planned growth targets for the Milestones page (web/src/pages/GrowthReport.jsx),
-- a deliberately separate layer from that page's existing real-data-only
-- summaries (server/agents/lib/growth-report.js). "here to here" trajectory:
-- baseline_value/baseline_date capture the real "here" at the moment a
-- target is set (server-resolved, never client-entered), target_value/date
-- are the planned "here". Replacing a target never overwrites target_value
-- in place -- the old row is marked superseded and a new active row is
-- inserted, so target history stays queryable for reporting.
CREATE TABLE growth_targets (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  metric TEXT NOT NULL CHECK (metric IN (
    'health_score', 'competitor_readiness', 'authority_score',
    'ai_recommendation_rate', 'impressions', 'clicks', 'ctr'
  )),
  target_value NUMERIC NOT NULL,
  target_date DATE NOT NULL,
  baseline_value NUMERIC,
  baseline_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active target per site+metric at a time.
CREATE UNIQUE INDEX growth_targets_active_unique ON growth_targets (site_id, metric) WHERE status = 'active';
CREATE INDEX idx_growth_targets_site_metric ON growth_targets (site_id, metric);
