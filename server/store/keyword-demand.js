import { query } from '../db.js';

// Real persisted history of monthly keyword_demand_runs (migration 157) —
// same "own marker table, not a sites column" precedent as
// getCompetitorRankingDates/saveCompetitorRankings, since this table is
// also the cost-auditing record of when DataForSEO's Keyword Data API was
// actually called for a site.

export async function getLatestKeywordDemandRunDates(siteId, limit = 1) {
  const { rows } = await query(
    `SELECT checked_at::date AS checked_at
       FROM keyword_demand_runs
      WHERE site_id = $1
      ORDER BY checked_at DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows.map((r) => r.checked_at);
}

export async function saveKeywordDemandRun(siteId, seedTerms, keywordsFound) {
  await query(
    `INSERT INTO keyword_demand_runs (site_id, seed_terms, keywords_found) VALUES ($1, $2, $3)`,
    [siteId, JSON.stringify(seedTerms), keywordsFound]
  );
}
