-- One day of a project's PostHog product metrics, beside ga4_daily.
--
-- A separate table rather than columns on ga4_daily, because these are a DIFFERENT measurement of a different thing.
-- GA4 counts arrivals as Google saw them; PostHog counts events as the client's own instance recorded them. The two
-- will never agree exactly — different identity, different session rules, different ad-blocker exposure — and putting
-- them in one row would invite a reader to treat one as a correction of the other, or to sum them. They are answers
-- to two questions: "how many came" and "what did they do".
--
-- Every metric is NULLABLE and defaults to NULL on purpose. A metric PostHog did not return must stay
-- distinguishable from a real zero: "nobody converted" and "we could not measure conversions" are different facts,
-- and a 0 in place of the second is the kind of quiet wrongness this schema exists to avoid.
--
-- `drop_offs` holds the events sessions ENDED on, which is the insight GA4 structurally cannot provide. Kept as JSONB
-- rather than its own table: it is a short, read-only top-N per day that is always read whole, never joined or
-- filtered, so a table would add a join for no query it would actually serve.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS posthog_daily (
  site_id    INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date       DATE        NOT NULL,
  events     INTEGER     CHECK (events IS NULL OR events >= 0),
  people     INTEGER     CHECK (people IS NULL OR people >= 0),
  pageviews  INTEGER     CHECK (pageviews IS NULL OR pageviews >= 0),
  sessions   INTEGER     CHECK (sessions IS NULL OR sessions >= 0),
  drop_offs  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, date)
);

-- The dashboard's read: one project's recent days, newest first.
CREATE INDEX IF NOT EXISTS posthog_daily_site_date_idx ON posthog_daily (site_id, date DESC);

ALTER TABLE posthog_daily ENABLE ROW LEVEL SECURITY;
