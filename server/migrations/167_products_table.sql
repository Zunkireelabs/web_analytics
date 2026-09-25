-- Universal Product Growth mode: a 'product' tenant is a fundamentally
-- different kind of thing from a 'website' tenant (no organic traffic, no
-- GSC/GA4 by default, a different lifecycle) even though it still logs in
-- and is staff-managed through the same `sites` row for auth/session/API
-- tokens/GitHub App connection — reusing that plumbing wholesale would be a
-- much larger, separate rebuild (a parallel login/session/staff-console
-- stack). This table is the real identity a product's own growth-mode data
-- (product_growth_config here, prospects/trial_signups — 168/169) is keyed
-- on, instead of conflating it with site_id the way
-- 167_product_growth_config.sql originally did: a site_id column on those
-- tables would silently imply "this data belongs to the website", which is
-- exactly the wrong model for a product tenant.
--
-- One products row per 'product' site, created lazily
-- (server/store/products.js's getOrCreateProductId) the first time any
-- growth-mode data needs to exist for that site — never eagerly for every
-- site, since a 'website' tenant never needs one at all.
CREATE TABLE IF NOT EXISTS products (
  id         SERIAL PRIMARY KEY,
  site_id    INT NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill: any site that already has a product_growth_config row (167,
-- applied before this file existed) gets its matching products row now, so
-- re-keying that table below never loses an existing config.
INSERT INTO products (site_id)
SELECT site_id FROM product_growth_config
ON CONFLICT (site_id) DO NOTHING;

-- Re-key product_growth_config off product_id instead of site_id.
ALTER TABLE product_growth_config ADD COLUMN IF NOT EXISTS product_id INT REFERENCES products(id) ON DELETE CASCADE;
UPDATE product_growth_config pgc SET product_id = p.id
  FROM products p WHERE p.site_id = pgc.site_id AND pgc.product_id IS NULL;
ALTER TABLE product_growth_config DROP CONSTRAINT IF EXISTS product_growth_config_pkey;
ALTER TABLE product_growth_config ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE product_growth_config ADD PRIMARY KEY (product_id);
ALTER TABLE product_growth_config DROP COLUMN IF EXISTS site_id;
