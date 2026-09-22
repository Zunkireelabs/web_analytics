-- Universal Product Growth mode, Phase 3/4: prospect discovery + the CRM
-- handoff boundary. Generic across any product tenant — nothing here names
-- Zenly, a market, or an industry; those all live in product_growth_config's
-- JSON columns (167) or on individual prospect rows as real evidence.

-- Per-site opt-in for prospect discovery (never gated on DataForSEO creds
-- merely being present — see the Universal Product Growth mode plan) and
-- the per-site secret an external CRM uses to call back into
-- server/routes/crm-webhook.js. NULL crm_webhook_token means the CRM
-- handoff isn't wired up yet for this site.
ALTER TABLE product_growth_config
  ADD COLUMN IF NOT EXISTS prospect_discovery_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS crm_webhook_token TEXT UNIQUE;

-- One row per discovered prospect. evidence_json is the real signal that
-- justified surfacing this prospect (e.g. which query it was found under,
-- which real page text matched a configured ICP signal) — never fabricated,
-- and a discovery run that can't back a candidate with evidence emits no row
-- at all rather than a low-confidence guess.
--
-- status is the configurable CRM lifecycle from the Product Growth spec
-- (prospect -> contacted -> interested -> demo_requested -> demo_booked ->
-- demo_completed -> trial -> converted -> lost) — stored as free text, not
-- an enum, so a different product's own lifecycle names aren't forced into
-- this one's vocabulary. 'new' is the only value this platform ever sets on
-- discovery; every later stage comes from either staff approval
-- (approved_for_crm) or a real CRM webhook call (crm_synced_at/status).
CREATE TABLE IF NOT EXISTS prospects (
  id                  SERIAL PRIMARY KEY,
  site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  company_name        TEXT,
  market              TEXT,
  industry            TEXT,
  qualification_reason TEXT NOT NULL,
  evidence_json       JSONB NOT NULL,
  confidence          TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low', 'medium', 'high')),
  recommended_segment TEXT,
  status              TEXT NOT NULL DEFAULT 'new',
  -- Human-approval gate (spec: never auto-send a new prospect segment) — a
  -- prospect is only ever included in the CRM export pull once this is true.
  approved_for_crm    BOOLEAN NOT NULL DEFAULT false,
  approved_at         TIMESTAMPTZ,
  -- Set once server/routes/crm-webhook.js's export endpoint has actually
  -- returned this row to the external CRM — distinct from approved_for_crm
  -- so "approved but not yet pulled" is a real, visible state.
  crm_synced_at       TIMESTAMPTZ,
  external_crm_id     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospects_site ON prospects (site_id, created_at DESC);
-- A prospect discovery run's own de-dup key: never surface the same
-- evidence-backed company twice for one site.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_site_company ON prospects (site_id, company_name) WHERE company_name IS NOT NULL;
