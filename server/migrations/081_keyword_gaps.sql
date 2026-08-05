-- Claude-identified keyword topics with zero real coverage today, given a
-- site's own real industry/profile and its own real existing clusters
-- (agents/clustering.py Step 3) — a human-review queue, never auto-applied.
-- Append-only: each run's gap analysis is its own snapshot, since a topic
-- can legitimately resurface across runs; status tracks whether a human has
-- acted on a specific row, not whether the topic is still a gap.
CREATE TABLE IF NOT EXISTS keyword_gaps (
  id          SERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  reason      TEXT,
  priority    TEXT NOT NULL DEFAULT 'medium',
  status      TEXT NOT NULL DEFAULT 'pending_review',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_priority_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_priority_check
  CHECK (priority IN ('high', 'medium', 'low'));

-- accepted/dismissed are the only two actions a human reviewer can take on a
-- pending_review row; not requested explicitly but a status column that can
-- only ever hold its own default would be pointless.
ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_status_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_status_check
  CHECK (status IN ('pending_review', 'accepted', 'dismissed'));

CREATE INDEX IF NOT EXISTS idx_keyword_gaps_lookup ON keyword_gaps (site_id, status, created_at DESC);
