import { query } from '../db.js';

// One optional row per site — absence means "use the generic multi-tenant
// strategy, no site-specific override" (see 155_site_seo_policy.sql).
export async function getSeoPolicy(siteId) {
  const { rows } = await query(
    `SELECT target_industries_json AS target_industries, cannibalization_policy,
            destination_link_policy, no_invented_data, updated_at
       FROM site_seo_policy
      WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function saveSeoPolicy(siteId, { targetIndustries, cannibalizationPolicy, destinationLinkPolicy, noInventedData }) {
  await query(
    `INSERT INTO site_seo_policy (site_id, target_industries_json, cannibalization_policy, destination_link_policy, no_invented_data, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (site_id) DO UPDATE SET
       target_industries_json = EXCLUDED.target_industries_json,
       cannibalization_policy = EXCLUDED.cannibalization_policy,
       destination_link_policy = EXCLUDED.destination_link_policy,
       no_invented_data = EXCLUDED.no_invented_data,
       updated_at = EXCLUDED.updated_at`,
    [siteId, JSON.stringify(targetIndustries || []), cannibalizationPolicy || null, destinationLinkPolicy || null, noInventedData !== false]
  );
}
