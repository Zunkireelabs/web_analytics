-- Universal Product Growth mode: lets a site be onboarded as a 'product'
-- rather than a 'website'. Zenly is the first tenant to use it, but nothing
-- here is Zenly-specific — property_type is a generic config dimension and
-- product_growth_config is an optional per-site override row, same
-- one-row-per-site convention as site_seo_policy (155).
--
-- Default 'website' preserves every existing site's current scheduling
-- behavior unchanged (see job.js's listConnectedSites relaxation in the
-- same change): a 'website' site still requires gsc_property/ga4_property_id
-- to be scheduled at all. A 'product' site is schedulable without them, and
-- gets a distinct set of capability-eligible agents (server/agents/runner.js
-- enforces this per-agent via meta.requiresCapabilities).
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS property_type TEXT NOT NULL DEFAULT 'website'
    CHECK (property_type IN ('website', 'product'));

-- Absence of a row means "no product-growth config yet" — a 'product' site
-- with no row here still gets its capability-eligible agents (technical/AEO/
-- visibility), it just has no configured markets/ICP/conversion event/CRM
-- target for the demand-generation layer.
--
-- conversion_event is free text on purpose (spec: booked_demo must not be
-- the only possible value) — 'booked_demo', 'trial', 'signup', 'purchase',
-- 'subscription' etc are all just strings a site owner configures.
CREATE TABLE IF NOT EXISTS product_growth_config (
  site_id          INT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  conversion_event TEXT,
  markets_json     JSONB,
  industries_json  JSONB,
  icp_signals_json JSONB,
  crm_config_json  JSONB,
  outreach_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
