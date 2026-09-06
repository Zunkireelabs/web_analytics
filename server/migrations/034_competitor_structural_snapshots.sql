-- Insert-only history for the competitor structural readiness score —
-- competitor_profiles (migration 025) overwrites per (site_id, domain) every
-- run, so there is no trend to chart even for a domain tracked across
-- multiple runs. Written alongside the existing upsertCompetitorProfile call
-- in server/agents/competitor-intelligence.js's run(), using the exact same
-- runAt/competitorScore/ownScore already computed there — no new scoring
-- logic, purely a second, append-only write of data that already exists.
--
-- Note: competitor identity is NOT stable run to run (the LLM-discovery lens
-- often names different real domains each run) — a per-domain trend will
-- often be short/sparse. See getMostTrackedCompetitorDomain in
-- server/store/competitor-profiles.js for how callers pick which domain
-- actually has enough real history to be worth charting.
CREATE TABLE IF NOT EXISTS competitor_structural_snapshots (
  id                SERIAL PRIMARY KEY,
  site_id           INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain            TEXT NOT NULL,
  competitor_score  INT NOT NULL,
  own_score         INT,
  snapshot_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, domain, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_competitor_structural_snapshots_site_domain
  ON competitor_structural_snapshots (site_id, domain, snapshot_at ASC);
