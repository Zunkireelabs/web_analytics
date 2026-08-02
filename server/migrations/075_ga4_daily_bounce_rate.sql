-- GA4's own native bounceRate metric (fraction 0-1, same precision as ctr) —
-- the canonical Bounce Rate definition per the metric-standardization audit,
-- chosen over deriving 1-engagement-rate since GA4's own calculation can
-- differ at the edges.
ALTER TABLE ga4_daily ADD COLUMN IF NOT EXISTS bounce_rate NUMERIC(7,5);
