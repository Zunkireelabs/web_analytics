-- Opportunity Watchlist — a persistent, self-maintaining queue of high-value
-- growth opportunities, distinct from the ephemeral findings list a fresh
-- analysis run produces. `opportunity_type` exists so a future opportunity
-- source (e.g. seasonal, once there's enough year-over-year history — see
-- agents/lib/watchlist.js) is a new value here, never a schema change.
-- Denormalized snapshot fields (title/reason/priority/expected_impact/
-- confidence/evidence/recommended_action) mean a watchlist item still reads
-- correctly even after the source finding itself has aged out of the
-- latest agent run.
CREATE TABLE IF NOT EXISTS watchlist_items (
  id                 SERIAL PRIMARY KEY,
  site_id            INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_type   TEXT NOT NULL DEFAULT 'growth',
  finding_id         TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  title              TEXT NOT NULL,
  reason             TEXT NOT NULL,
  priority           TEXT NOT NULL,
  expected_impact    JSONB,
  confidence         TEXT,
  evidence           JSONB,
  recommended_action JSONB,
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'completed', 'no_longer_applicable')),
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_site_status ON watchlist_items (site_id, status, discovered_at DESC);
