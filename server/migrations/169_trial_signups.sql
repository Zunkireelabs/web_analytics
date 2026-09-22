-- Universal Product Growth mode: "see it live" self-serve trial tracking,
-- separate from the demo-request lead flow (prospects, 168) and from the
-- booked-demo conversion event — a trial signup is a different conversion
-- event (product_growth_config.conversion_event might be 'trial' instead
-- of/alongside 'booked_demo'), reported by the product's own login/sandbox
-- system (which lives outside this repo, e.g. Zenly's own app) via a new
-- webhook, the same external-boundary shape as the CRM handoff (168).
--
-- Every signup is classified, but NEVER auto-blocked — classification is
-- evidence for a human to review and act on outside this platform.
ALTER TABLE product_growth_config
  -- Free-text phrases the site owner configures as "language a company
  -- selling something like ours would use on its own homepage" — e.g.
  -- "booking software", "salon management platform". Generic per-product,
  -- never hardcoded: this is what makes classification evidence-based
  -- instead of a guess from the company name alone.
  ADD COLUMN IF NOT EXISTS competitor_signals_json JSONB;

CREATE TABLE IF NOT EXISTS trial_signups (
  id                     SERIAL PRIMARY KEY,
  site_id                INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email                  TEXT,
  company_name           TEXT,
  company_domain         TEXT,
  -- Free text, e.g. 'zenly-trial' — whichever external product reported
  -- this signup, since one analytics site could in principle receive
  -- signups from more than one of its own product surfaces.
  source                 TEXT,
  -- 'unclassified' until the webhook's own real evidence check runs;
  -- 'prospect' (no competitor signal found), 'competitor_suspect' (real
  -- evidence the signup's own domain sells something similar) — never a
  -- third silently-invented value, see classify() in trial-signups.js.
  classification         TEXT NOT NULL DEFAULT 'unclassified',
  -- The real evidence the classification was based on (matched competitor
  -- domain, matched phrase + source URL) — never fabricated, and absent
  -- entirely when the signup's own domain couldn't be checked at all
  -- (unreachable, private/local, no domain given).
  classification_evidence JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_signups_site ON trial_signups (site_id, created_at DESC);
