-- Per-site SEO growth policy — same one-row-per-site convention as
-- site_profiles (080), but for owner-set strategy constraints rather than
-- inferred-from-GSC facts. Consumed by content-gap.js (topic sourcing) and
-- blog-outline.js (generation prompt) to steer topic/industry focus,
-- cannibalization tolerance, destination-link scope, and whether the
-- generator may fall back to LLM-guessed search-demand numbers when no real
-- provider data is available (see server/providers/search-demand/).
-- Optional per site: a NULL row means "use the generic multi-tenant
-- defaults" everywhere this is read — this table only overrides, per site,
-- it never replaces the generic strategy.
CREATE TABLE IF NOT EXISTS site_seo_policy (
  site_id                 INT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  target_industries_json  JSONB,
  cannibalization_policy  TEXT,
  destination_link_policy TEXT,
  no_invented_data        BOOLEAN NOT NULL DEFAULT true,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Zunkiree Labs' own site (id=1, see 151_sites_client_number.sql) — the
-- 2026-09-10 SEO growth rule. Guarded so a future manual edit to this row
-- isn't clobbered by re-running this migration.
INSERT INTO site_seo_policy (site_id, target_industries_json, cannibalization_policy, destination_link_policy, no_invented_data)
VALUES (
  1,
  '["Education", "Healthcare", "Real Estate", "Hospitality", "Agencies"]'::jsonb,
  'Keyword overlap between a blog and the homepage is never treated as cannibalization automatically. Keep valuable ranking content unless there is real evidence it is hurting performance.',
  'Only link to current, live pages on the site. Never link to a removed or obsolete product page.',
  true
)
ON CONFLICT (site_id) DO NOTHING;
