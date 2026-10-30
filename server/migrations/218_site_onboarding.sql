-- What a person told us on the /get-started flow, kept with the project it created.
--
-- The get-started page collects the brand, the country the business is legally in, where to run prompts,
-- a brand profile, goals, markets, topics and the prompts SuperRank wrote. The project, its time zone and
-- its goal become real columns elsewhere; the rest has no home yet (nothing runs the prompts yet), so it is
-- kept here as one document per project rather than lost. One row per project; sent again, it replaces.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS site_onboarding (
  site_id    INTEGER     PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL,
  created_by INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
