-- Caches the outcome of agents/lib/location-service-gap.js's evidence check
-- (real search demand + tenant-declared expansion target + known offering)
-- for one (site, data file, location, service) gap. Two reasons this needs
-- its own persisted record rather than re-deriving fresh every sync pass:
--
--   1. cost: SAFE_RECOVERY/INSUFFICIENT_DATA both call DataForSEO's Keyword
--      Data API, billed per call — recomputing on every daily
--      refreshBlockedRecommendations pass would re-charge for the exact same
--      question every day forever.
--   2. dead-lettering: an INSUFFICIENT_DATA verdict must stop being re-tried
--      every run, same "considered and refused, not silently retried
--      forever" posture recommendation_attempts already gives real drafts
--      (see migration 139) — this is that same posture one layer earlier,
--      before a draft (or even an open recommendation) exists at all.
--
-- One row per gap, re-evaluated on a cooldown (application-level, same
-- monthly-recheck convention as keyword_demand_runs) rather than never —
-- real demand and a tenant's own declared service area can both change.
CREATE TABLE IF NOT EXISTS location_service_gap_evaluations (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  data_file     TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('SAFE_RECOVERY', 'INSUFFICIENT_DATA')),
  reason        TEXT NOT NULL,
  evidence      JSONB,
  evaluated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, data_file, location_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_location_service_gap_evaluations_lookup
  ON location_service_gap_evaluations (site_id, data_file, location_id, service_id);
