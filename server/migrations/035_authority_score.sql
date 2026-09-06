-- Real, reproducible backlink-based Authority Score (server/agents/authority.js).
-- One row per site per real monthly check — never overwritten in place, so
-- there is a real trend to chart and a real prior snapshot to diff against
-- for "why did the score change" (see score_breakdown below).
--
-- scoring_version exists so a future change to the weighting formula never
-- silently reinterprets an old score under new rules — a caller comparing
-- across scoring_version boundaries can detect the change instead of
-- reading a discontinuity as a real swing in authority.
--
-- score_breakdown stores each component's raw input, computed sub-score,
-- and weight — the literal "why the score changed" data (e.g. "+18
-- referring domains" in an executive narrative is a diff of two real stored
-- breakdowns, never asked of an LLM to compute). raw_summary keeps the full
-- DataForSEO response for audit/reproducibility — "no black box" per the
-- agent's design.
CREATE TABLE IF NOT EXISTS authority_snapshots (
  id                    SERIAL PRIMARY KEY,
  site_id               INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  snapshot_date         DATE NOT NULL,
  scoring_version       INT NOT NULL,
  referring_domains     INT,
  referring_main_domains INT,
  total_backlinks       INT,
  follow_backlinks      INT,
  nofollow_backlinks    INT,
  referring_ips         INT,
  referring_subnets     INT,
  new_backlinks_30d     INT,
  lost_backlinks_30d    INT,
  anchor_diversity_score NUMERIC,
  authority_score       INT NOT NULL,
  score_breakdown       JSONB NOT NULL,
  top_linked_pages      JSONB,
  raw_summary           JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_authority_snapshots_site_date
  ON authority_snapshots (site_id, snapshot_date DESC);
