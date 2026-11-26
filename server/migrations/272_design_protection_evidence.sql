-- DESIGN PROTECTION (Phase 3): the captured baseline per TEMPLATE and the evidence for every decision.
--
-- design_baselines: what a site's template really renders (typography tokens at 1440 and 390 px, the class vocabulary, the patterns it already has for
-- FAQ / tables / related links / breadcrumbs), measured from live pages of that exact template with platform output (SEOAI:* blocks) and cookie/consent
-- overlays removed first, so neither pollutes what "the site looks like" means. One row per project per template: a baseline is never shared across
-- projects and never borrowed from a different template. status:
--   requested  a visible change needs this template and no usable baseline exists; the Design Agent queue captures it (the change waits as awaiting-baseline)
--   ready      measured from agreeing samples; usable
--   unstable   the samples disagree with each other beyond tolerance; NOT usable (a person or a re-capture decides which one is the template)
--   failed     capture could not run (pages unreachable, no body region); retried later
-- A ready baseline older than the max age (DESIGN_BASELINE_MAX_AGE_DAYS, default 30) is treated as stale by the reader: not usable until re-captured.
--
-- design_protection_decisions: every decision, passes included, in log AND enforce mode, so a false failure is measurable before it blocks anything.
-- Additive and idempotent, like every file here; no data statements.

CREATE TABLE IF NOT EXISTS design_baselines (
  id            BIGSERIAL PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  template_key  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested',
  tokens        JSONB,
  patterns      JSONB,
  vocabulary    JSONB,
  sample_urls   JSONB,
  confidence    TEXT,
  disagreements JSONB,
  capture_error TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT design_baselines_status_check CHECK (status IN ('requested', 'ready', 'unstable', 'failed')),
  CONSTRAINT design_baselines_site_template_unique UNIQUE (site_id, template_key)
);

CREATE TABLE IF NOT EXISTS design_protection_decisions (
  id           BIGSERIAL PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  draft_id     INTEGER,
  action_type  TEXT,
  template_key TEXT,
  page_url     TEXT,
  visible      BOOLEAN NOT NULL,
  verdict      TEXT NOT NULL,
  mode         TEXT NOT NULL,
  blocked      BOOLEAN NOT NULL DEFAULT false,
  would_block  BOOLEAN NOT NULL DEFAULT false,
  repaired     BOOLEAN NOT NULL DEFAULT false,
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS design_protection_decisions_site_idx ON design_protection_decisions (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS design_protection_decisions_verdict_idx ON design_protection_decisions (mode, verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS design_baselines_status_idx ON design_baselines (status, requested_at);
