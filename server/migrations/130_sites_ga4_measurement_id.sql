-- The site's real GA4 gtag Measurement ID (G-XXXXXXXXXX), distinct from the
-- existing ga4_property_id (the numeric GA4 Data API property used for
-- reporting ingestion) — the analytics-install generator needs this to draft
-- a real install script instead of shipping a placeholder that blocks
-- auto-publish (server/generators/analytics-install.js).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT;
