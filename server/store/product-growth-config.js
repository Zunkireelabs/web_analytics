import { query } from '../db.js';

// One optional row per site — absence means "product-growth capabilities are
// eligible (if property_type = 'product') but nothing is configured yet: no
// markets/ICP/conversion event/CRM target". Same convention as
// site_seo_policy.js (see 167_product_growth_config.sql).
export async function getProductGrowthConfig(siteId) {
  const { rows } = await query(
    `SELECT conversion_event, markets_json AS markets, industries_json AS industries,
            icp_signals_json AS icp_signals, crm_config_json AS crm_config,
            outreach_enabled, updated_at
       FROM product_growth_config
      WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function saveProductGrowthConfig(siteId, { conversionEvent, markets, industries, icpSignals, crmConfig, outreachEnabled }) {
  await query(
    `INSERT INTO product_growth_config (site_id, conversion_event, markets_json, industries_json, icp_signals_json, crm_config_json, outreach_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (site_id) DO UPDATE SET
       conversion_event = EXCLUDED.conversion_event,
       markets_json = EXCLUDED.markets_json,
       industries_json = EXCLUDED.industries_json,
       icp_signals_json = EXCLUDED.icp_signals_json,
       crm_config_json = EXCLUDED.crm_config_json,
       outreach_enabled = EXCLUDED.outreach_enabled,
       updated_at = EXCLUDED.updated_at`,
    [
      siteId,
      conversionEvent || null,
      JSON.stringify(markets || []),
      JSON.stringify(industries || []),
      JSON.stringify(icpSignals || []),
      JSON.stringify(crmConfig || {}),
      outreachEnabled === true,
    ]
  );
}
