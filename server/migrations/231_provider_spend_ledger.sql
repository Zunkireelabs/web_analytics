-- Provider spend ledger: one row per paid external API call (DataForSEO first), so spend can be seen and capped per project.
--
-- cost_usd is the cost the provider itself reported in its response (DataForSEO returns `cost` per call). It is never
-- estimated here: when a response carries no cost the row stores NULL and status 'ok', so a gap in reporting is visible
-- instead of silently counted as zero. A refused call (budget reached) is also recorded, with status 'budget_refused' and no cost.
--
-- site_id is required: every paid call belongs to a project. Platform-level calls with no project use the company site.
-- site_provider_budget holds an optional monthly cap per project and provider; no row = no cap (current behaviour).
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS provider_spend_ledger (
  id          BIGSERIAL     PRIMARY KEY,
  site_id     INTEGER       NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider    TEXT          NOT NULL,
  endpoint    TEXT          NOT NULL,
  job         TEXT          NOT NULL,
  cost_usd    NUMERIC(12,6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  status      TEXT          NOT NULL CHECK (status IN ('ok', 'failed', 'charged_failed', 'budget_refused')),
  http_status INTEGER,
  detail      TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_spend_ledger_site_month_idx ON provider_spend_ledger (site_id, provider, created_at DESC);

CREATE TABLE IF NOT EXISTS site_provider_budget (
  site_id     INTEGER       NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider    TEXT          NOT NULL,
  monthly_usd NUMERIC(12,2) NOT NULL CHECK (monthly_usd >= 0),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, provider)
);

-- Same state as every other table in this schema (see 225): RLS on, no policies; the app connects as a role that bypasses it.
ALTER TABLE provider_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_provider_budget ENABLE ROW LEVEL SECURITY;
