import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { getOrCreateProductId, getProductIdBySiteId } from './products.js';

// One optional row per PRODUCT (167_products_table — never site_id directly:
// a 'product' tenant's growth-mode data is a different kind of thing from
// the website row backing its auth/session, see products.js). Absence means
// "product-growth capabilities are eligible (if property_type = 'product')
// but nothing is configured yet: no markets/ICP/conversion event/CRM
// target". Same convention as site_seo_policy.js (see
// 167_product_growth_config.sql/167_products_table.sql).
//
// Every function here still takes siteId, not productId — every caller
// (routes/clients.js, routes/demand.js, agents/prospect-discovery.js, ...)
// only ever knows the site it's acting on, the same way it always has; the
// site_id -> product_id resolution is entirely internal to this module.
export async function getProductGrowthConfig(siteId) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return null;

  const { rows } = await query(
    `SELECT conversion_event, markets_json AS markets, industries_json AS industries,
            icp_signals_json AS icp_signals, crm_config_json AS crm_config,
            competitor_signals_json AS competitor_signals,
            outreach_enabled, prospect_discovery_enabled, crm_webhook_token, updated_at
       FROM product_growth_config
      WHERE product_id = $1`,
    [productId]
  );
  return rows[0] || null;
}

export async function saveProductGrowthConfig(siteId, { conversionEvent, markets, industries, icpSignals, crmConfig, outreachEnabled, competitorSignals }) {
  const productId = await getOrCreateProductId(siteId);
  await query(
    `INSERT INTO product_growth_config (product_id, conversion_event, markets_json, industries_json, icp_signals_json, crm_config_json, outreach_enabled, competitor_signals_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (product_id) DO UPDATE SET
       conversion_event = EXCLUDED.conversion_event,
       markets_json = EXCLUDED.markets_json,
       industries_json = EXCLUDED.industries_json,
       icp_signals_json = EXCLUDED.icp_signals_json,
       crm_config_json = EXCLUDED.crm_config_json,
       outreach_enabled = EXCLUDED.outreach_enabled,
       competitor_signals_json = EXCLUDED.competitor_signals_json,
       updated_at = EXCLUDED.updated_at`,
    [
      productId,
      conversionEvent || null,
      JSON.stringify(markets || []),
      JSON.stringify(industries || []),
      JSON.stringify(icpSignals || []),
      JSON.stringify(crmConfig || {}),
      outreachEnabled === true,
      JSON.stringify(competitorSignals || []),
    ]
  );
}

// Own opt-in flag for prospect discovery (168) — never gated on
// DataForSEO credentials merely being present, see prospect-discovery.js's
// meta comment. An INSERT here (no existing row) leaves every other column
// at its default, same "absence means unconfigured" convention as above.
export async function setProspectDiscoveryEnabled(siteId, enabled) {
  const productId = await getOrCreateProductId(siteId);
  await query(
    `INSERT INTO product_growth_config (product_id, prospect_discovery_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (product_id) DO UPDATE SET prospect_discovery_enabled = EXCLUDED.prospect_discovery_enabled, updated_at = EXCLUDED.updated_at`,
    [productId, enabled === true]
  );
}

// Generates a fresh per-product secret an external CRM presents on every
// call to server/routes/crm-webhook.js — idempotent no-op if one already
// exists, since rotating it would silently break whatever CRM integration
// was already configured with the old value.
export async function ensureCrmWebhookToken(siteId) {
  const existing = await getProductGrowthConfig(siteId);
  if (existing?.crm_webhook_token) return existing.crm_webhook_token;

  const productId = await getOrCreateProductId(siteId);
  const token = randomBytes(24).toString('hex');
  await query(
    `INSERT INTO product_growth_config (product_id, crm_webhook_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (product_id) DO UPDATE SET crm_webhook_token = EXCLUDED.crm_webhook_token, updated_at = EXCLUDED.updated_at`,
    [productId, token]
  );
  return token;
}

// Resolves which SITE a CRM webhook call is for from its bearer token —
// never from a client-supplied site id, the same "identity comes from the
// secret, not the request" discipline getSiteByRepo's comment describes for
// GitHub webhooks. Joins products back to its site_id so every caller
// (crm-webhook.js, trial-signup.js) keeps working in terms of siteId exactly
// as before this table was re-keyed onto product_id.
export async function getSiteIdByCrmWebhookToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT p.site_id AS "siteId"
       FROM product_growth_config pgc
       JOIN products p ON p.id = pgc.product_id
      WHERE pgc.crm_webhook_token = $1`,
    [token]
  );
  return rows[0]?.siteId || null;
}
