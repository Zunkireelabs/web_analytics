-- An explicit brand colour for a project's reports, for when the design profile cannot give one. The design profile
-- (sites.url_file_map.siteRoot.designProfile) often stores the accent as a utility class name such as
-- 'text-zunkiree-600' or 'text-blue-dark', which carries no colour we can read; a person who knows the real brand can
-- set it here (#rrggbb). NULL = not set, and reports then fall back to what the design profile can give, then to the
-- Zunkiree green. Used first when set.
--
-- Additive and idempotent; no data statements.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS brand_color TEXT;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_brand_color_hex;
ALTER TABLE sites ADD CONSTRAINT sites_brand_color_hex CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$');
