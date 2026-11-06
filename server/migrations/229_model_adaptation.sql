-- Phase 7 (model adaptation readiness). Everything here is OPTIONAL: nothing in the running system reads these tables unless
-- MODEL_REGISTRY=on, and with no active registered model (the default) the platform uses exactly the models it uses today.
--
-- training_datasets  - one row per prepared dataset VERSION: a manifest (counts, split sizes, source rules, scrubber version),
--                      never the examples themselves. `version` is a hash of the content, so the same data is the same
--                      version and any change is a new one. Datasets are written as files by the preparation script.
-- model_registry     - a model the platform could use, with its evaluation results and a lifecycle:
--                      candidate -> approved -> active -> retired, or rejected. At most one 'active' model per role.
--                      Promotion is gated in code (lib/model-adaptation.js) and always names a person and a reason.
-- model_registry_log - append-only history of every registration, evaluation, promotion, rollback and rejection.
--
-- Like industry_knowledge, none of these tables has a site_id or workspace_id: they describe datasets and models, not tenants.
-- Additive and idempotent, no data statements.
CREATE TABLE IF NOT EXISTS training_datasets (
  id          BIGSERIAL   PRIMARY KEY,
  version     TEXT        NOT NULL UNIQUE,
  schema_version INTEGER  NOT NULL,
  manifest    JSONB       NOT NULL,
  created_by  TEXT        NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_registry (
  id              BIGSERIAL   PRIMARY KEY,
  role            TEXT        NOT NULL CHECK (role IN ('decision')),
  name            TEXT        NOT NULL,
  provider        TEXT        NOT NULL,
  model_id        TEXT        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('base', 'fine-tuned')),
  dataset_version TEXT,
  status          TEXT        NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'active', 'retired', 'rejected')),
  evaluation      JSONB,
  notes           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at    TIMESTAMPTZ,
  UNIQUE (role, provider, model_id, dataset_version)
);
-- At most one active model per role: the database itself refuses a second one.
CREATE UNIQUE INDEX IF NOT EXISTS model_registry_one_active_idx ON model_registry (role) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS model_registry_log (
  id          BIGSERIAL   PRIMARY KEY,
  model_id    BIGINT      REFERENCES model_registry(id) ON DELETE SET NULL,
  event       TEXT        NOT NULL CHECK (event IN ('registered', 'evaluated', 'approved', 'promoted', 'rolled-back', 'rejected', 'retired')),
  from_status TEXT,
  to_status   TEXT,
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason      TEXT        NOT NULL DEFAULT '',
  actor       TEXT        NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_registry_log_model_idx ON model_registry_log (model_id, created_at DESC);

ALTER TABLE training_datasets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_registry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_registry_log   ENABLE ROW LEVEL SECURITY;
