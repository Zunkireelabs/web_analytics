-- One queue of content topics, scored, with the score broken into the
-- components that produced it. (server/agents/lib/topic-scorer.js)
--
-- Today there are two separate, disagreeing sources of "what should we
-- write about next", and nothing that reconciles them:
--
--   * Keyword gaps are ranked by real search volume, and ship through
--     qualifyAndShipContentGaps' own top-5-by-volume pool.
--   * Trend topics come from RSS headlines, carry demand "unverified"
--     because no search-demand provider was registered, and ship through a
--     different path entirely.
--
-- So a topic that is both genuinely trending AND genuinely searched — the
-- best topic there is — gets no advantage over one that is merely one of
-- them, because the two signals are never seen together. That is what this
-- table and its scorer exist to fix.
--
-- WHY THE COMPONENTS ARE STORED, not just the score: a score you cannot
-- explain cannot be tuned, and cannot be argued with when it is wrong. Every
-- weight that went into a number is kept beside it, so "why is this topic
-- above that one" is answerable from the row a month later, including for
-- rows produced by a weighting that has since changed.
CREATE TABLE IF NOT EXISTS topic_candidates (
  id              BIGSERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Slugified topic, the stable identity. The display topic is kept
  -- separately because a human-readable title is what the generator needs
  -- and a slug is what dedup needs; deriving one from the other at read
  -- time loses the original casing and punctuation.
  topic_key       TEXT NOT NULL,
  topic           TEXT NOT NULL,
  -- 'keyword-gap' | 'trend-radar' | 'analyst' | 'manual' — which pipeline
  -- put it forward. A topic can be proposed by more than one, and that is
  -- the interesting case: see sources_json.
  origin          TEXT NOT NULL,
  -- Every pipeline that proposed this topic, so "both trending and searched"
  -- is a readable fact rather than something inferred from two rows.
  sources_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent          TEXT,
  score           NUMERIC NOT NULL DEFAULT 0,
  components_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The honest demand record, in the same shape the SearchDemandProvider
  -- contract returns — including `available: false` with its reason. A
  -- stored topic therefore carries permanent proof of whether real volume
  -- data informed its rank, which is exactly the distinction the null
  -- provider was built to preserve.
  demand_json     JSONB,
  coverage_status TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  dropped_reason  TEXT,
  scored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at      TIMESTAMPTZ,
  recommendation_id BIGINT
);

ALTER TABLE topic_candidates DROP CONSTRAINT IF EXISTS topic_candidates_status_check;
ALTER TABLE topic_candidates ADD CONSTRAINT topic_candidates_status_check
  CHECK (status IN ('queued', 'shipped', 'dropped'));

ALTER TABLE topic_candidates DROP CONSTRAINT IF EXISTS topic_candidates_origin_check;
ALTER TABLE topic_candidates ADD CONSTRAINT topic_candidates_origin_check
  CHECK (origin IN ('keyword-gap', 'trend-radar', 'analyst', 'manual'));

-- One row per (site, topic): re-scoring updates in place rather than
-- appending, so the queue is the current answer and not a history of every
-- time cron ran. The components are the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS topic_candidates_key
  ON topic_candidates (site_id, topic_key);

-- The read the ship cycle actually performs: this site's queued topics,
-- best first.
CREATE INDEX IF NOT EXISTS topic_candidates_queue_idx
  ON topic_candidates (site_id, score DESC)
  WHERE status = 'queued';
