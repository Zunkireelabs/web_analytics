import { query } from '../db.js';

// Settings for the news-posts agent. null when the project has no row.
export async function getNewsConfig(siteId) {
  const { rows } = await query('SELECT * FROM site_news_config WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}

export async function saveNewsConfig(siteId, { enabled, intervalDays, officialSources, leadFeeds, styleRules }) {
  const { rows } = await query(
    `INSERT INTO site_news_config (site_id, enabled, interval_days, official_sources, lead_feeds, style_rules, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
     ON CONFLICT (site_id) DO UPDATE SET enabled = EXCLUDED.enabled, interval_days = EXCLUDED.interval_days,
       official_sources = EXCLUDED.official_sources, lead_feeds = EXCLUDED.lead_feeds, style_rules = EXCLUDED.style_rules, updated_at = now()
     RETURNING *`,
    [siteId, !!enabled, intervalDays ?? 7, JSON.stringify(officialSources ?? []), JSON.stringify(leadFeeds ?? []), styleRules ?? null]);
  return rows[0];
}
