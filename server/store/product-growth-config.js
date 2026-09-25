import { randomBytes } from 'node:crypto';
import { query } from '../db.js';

// One optional row per site — absence means "product-growth capabilities are
// eligible (if property_type = 'product') but nothing is configured yet: no
// markets/ICP/conversion event/CRM target". Same convention as
// site_seo_policy.js (see 167_product_growth_config.sql).
export async function getProductGrowthConfig(siteId) {
  const { rows } = await query(
    `SELECT conversion_event, markets_json AS markets, industries_json AS industries,
            icp_signals_json AS icp_signals, crm_config_json AS crm_config,
            competitor_signals_json AS competitor_signals,
            outreach_enabled, prospect_discovery_enabled, crm_webhook_token, updated_at
       FROM product_growth_config
      WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function saveProductGrowthConfig(siteId, { conversionEvent, markets, industries, icpSignals, crmConfig, outreachEnabled, competitorSignals }) {
  await query(
    `INSERT INTO product_growth_config (site_id, conversion_event, markets_json, industries_json, icp_signals_json, crm_config_json, outreach_enabled, competitor_signals_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (site_id) DO UPDATE SET
       conversion_event = EXCLUDED.conversion_event,
       markets_json = EXCLUDED.markets_json,
       industries_json = EXCLUDED.industries_json,
       icp_signals_json = EXCLUDED.icp_signals_json,
       crm_config_json = EXCLUDED.crm_config_json,
       outreach_enabled = EXCLUDED.outreach_enabled,
       competitor_signals_json = EXCLUDED.competitor_signals_json,
       updated_at = EXCLUDED.updated_at`,
    [
      siteId,
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
  await query(
    `INSERT INTO product_growth_config (site_id, prospect_discovery_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (site_id) DO UPDATE SET prospect_discovery_enabled = EXCLUDED.prospect_discovery_enabled, updated_at = EXCLUDED.updated_at`,
    [siteId, enabled === true]
  );
}

// Generates a fresh per-site secret an external CRM presents on every call
// to server/routes/crm-webhook.js — idempotent no-op if one already exists,
// since rotating it would silently break whatever CRM integration was
// already configured with the old value.
export async function ensureCrmWebhookToken(siteId) {
  const existing = await getProductGrowthConfig(siteId);
  if (existing?.crm_webhook_token) return existing.crm_webhook_token;

  const token = randomBytes(24).toString('hex');
  await query(
    `INSERT INTO product_growth_config (site_id, crm_webhook_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (site_id) DO UPDATE SET crm_webhook_token = EXCLUDED.crm_webhook_token, updated_at = EXCLUDED.updated_at`,
    [siteId, token]
  );
  return token;
}

// Resolves which site a CRM webhook call is for from its bearer token —
// never from a client-supplied site id, the same "identity comes from the
// secret, not the request" discipline getSiteByRepo's comment describes for
// GitHub webhooks.
export async function getSiteIdByCrmWebhookToken(token) {
  if (!token) return null;
  const { rows } = await query(`SELECT site_id FROM product_growth_config WHERE crm_webhook_token = $1`, [token]);
  return rows[0]?.site_id || null;
}
