import { query } from '../db.js';

// The identity Universal Product Growth mode's own tables (product_growth_
// config, prospects, trial_signups — 167/168/169) key on, instead of
// site_id: a 'product' tenant is a fundamentally different kind of thing
// from a 'website' tenant (no organic traffic, no GSC/GA4 by default, a
// different lifecycle), even though it still logs in and is staff-managed
// through the same `sites` row for auth/session/API tokens/GitHub App
// connection — that plumbing is reused as-is rather than rebuilt in
// parallel for products. One products row per site, created lazily the
// first time any growth-mode data actually needs to exist for it.

export async function getOrCreateProductId(siteId) {
  const { rows } = await query(
    `INSERT INTO products (site_id) VALUES ($1)
     ON CONFLICT (site_id) DO UPDATE SET site_id = EXCLUDED.site_id
     RETURNING id`,
    [siteId]
  );
  return rows[0].id;
}

// Read-only lookup — null means no growth-mode data has ever been created
// for this site, distinct from "created but empty", the same "absence means
// unconfigured" convention product_growth_config itself uses.
export async function getProductIdBySiteId(siteId) {
  const { rows } = await query(`SELECT id FROM products WHERE site_id = $1`, [siteId]);
  return rows[0]?.id || null;
}

export async function getSiteIdByProductId(productId) {
  const { rows } = await query(`SELECT site_id FROM products WHERE id = $1`, [productId]);
  return rows[0]?.site_id || null;
}
