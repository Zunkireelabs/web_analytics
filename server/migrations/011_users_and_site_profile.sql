-- Client-profile foundation: allow a site to exist before its GSC/GA4
-- properties are connected, add a real per-user login tied to a site, and
-- add a human-friendly domain field for UI display (gsc_property's
-- 'sc-domain:...' / 'https://...' format isn't presentable copy).
--
-- Additive/non-destructive: every existing sites row already has non-null
-- gsc_property/ga4_property_id, so relaxing NOT NULL changes no data and
-- cannot fail. getOrCreateSite() in server/db.js is untouched and keeps
-- requiring/writing non-null values for existing env-driven sites, so
-- production ingestion behavior is unaffected by this migration.

ALTER TABLE sites ALTER COLUMN gsc_property DROP NOT NULL;
ALTER TABLE sites ALTER COLUMN ga4_property_id DROP NOT NULL;

-- Friendly display domain (e.g. "example.com"), independent of GSC's
-- property-id format. Nullable/optional.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS website_domain TEXT;

-- One login per site for now (no multi-user-per-site, no multi-site-per-user
-- support yet). Email is globally unique; login looks a user up by email
-- alone and derives site_id from this row.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_site ON users (site_id);
