-- Product-visibility growth objective, Phase 5: is Zunkiree (or any client
-- using this) becoming MORE visible for a given product capability over
-- time — not just its current impressions/position, which
-- buildProductTopicMap (server/agents/lib/analyst-seo-mapping.js) already
-- computes fresh on every read but never persists. This table is that
-- read's history: one row per verified capability per snapshot run, so a
-- later run can diff against the prior one for a real trend instead of a
-- single point-in-time number.
--
-- Deliberately raw values only (avg_impressions/avg_position/gap counts),
-- not precomputed pct_change like data-analyst-agent's metric_period_stats —
-- there's no wow/mom distinction here (snapshots run on the same 14-day
-- cadence as the clustering data they're derived from), so a simple
-- "diff against the most recent prior row" at read time is enough and
-- avoids a second write path to keep in sync if the cadence ever changes.
CREATE TABLE IF NOT EXISTS capability_visibility_snapshots (
  id                  SERIAL PRIMARY KEY,
  site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  capability_id       INT NOT NULL REFERENCES product_capabilities(id) ON DELETE CASCADE,
  avg_impressions     NUMERIC,
  avg_position        NUMERIC,
  open_gap_count      INT NOT NULL DEFAULT 0,
  approved_gap_count  INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capability_visibility_snapshots_lookup
  ON capability_visibility_snapshots (site_id, capability_id, created_at DESC);
