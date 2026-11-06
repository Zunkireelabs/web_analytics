-- What a day's GA4 figures are actually worth, stored beside them.
--
-- GA4 withholds rows for privacy, collapses high-cardinality tails into "(other)", and sometimes estimates from a
-- sample. Each makes a number smaller than reality, none is an error we can fix, and showing such a number as if it
-- were exact is how a dashboard ends up disagreeing with the client's own GA4 screen and losing their trust in every
-- other figure on the page. ingest/ga4-data-quality.js already computes the verdict per day; this is where it is kept
-- so the dashboard can show it rather than implying precision the data does not have.
--
--   data_confidence  'complete'  nothing withheld, nothing sampled, breakdowns account for their totals
--                    'partial'   something was withheld or bucketed, or a breakdown did not reconcile; the TOTALS
--                                are still GA4's own numbers, but a breakdown is not the full list
--                    'estimated' the report was sampled, so even the totals are an estimate
--   data_quality     the flags and the plain-sentence notes behind that verdict, for display
--
-- NULL means a day ingested before this existed. Deliberately not defaulted to 'complete': a day we never assessed
-- must not claim it was clean. Readers show nothing for NULL rather than a reassuring badge.
--
-- Additive and idempotent, like every file here; no data statements.
ALTER TABLE ga4_daily ADD COLUMN IF NOT EXISTS data_confidence TEXT;
ALTER TABLE ga4_daily ADD COLUMN IF NOT EXISTS data_quality    JSONB;

ALTER TABLE ga4_daily DROP CONSTRAINT IF EXISTS ga4_daily_data_confidence_check;
ALTER TABLE ga4_daily ADD CONSTRAINT ga4_daily_data_confidence_check
  CHECK (data_confidence IS NULL OR data_confidence IN ('complete', 'partial', 'estimated'));

-- The dashboard's own lookup: the days in a range that are worth warning about.
CREATE INDEX IF NOT EXISTS ga4_daily_confidence_idx
  ON ga4_daily (site_id, date DESC) WHERE data_confidence IS NOT NULL AND data_confidence <> 'complete';
