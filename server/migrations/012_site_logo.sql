-- Per-client logo, shown in the dashboard Header once a user is logged in
-- (never on the Login screen itself, since the client isn't known yet).
-- Stored as a data URI directly in Postgres — consistent with the rest of
-- this app's "no local file storage" design — rather than a filesystem path
-- or external object storage. Nullable: a site with no logo set falls back
-- to the product's own logo in the UI.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS logo_data_url TEXT;
