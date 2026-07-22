import { query } from '../db.js';

// authority_snapshots (migration 035) — one real row per site per monthly
// check, never overwritten in place, so there's always a real prior
// snapshot to diff against for "why did the score change."

export async function getLatestAuthoritySnapshot(siteId) {
  const { rows } = await query(
    `SELECT * FROM authority_snapshots WHERE site_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function getAuthoritySnapshotHistory(siteId, limit = 12) {
  const { rows } = await query(
    `SELECT * FROM authority_snapshots WHERE site_id = $1 ORDER BY snapshot_date DESC LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function saveAuthoritySnapshot(siteId, snapshotDate, data) {
  const { rows } = await query(
    `INSERT INTO authority_snapshots (
       site_id, snapshot_date, scoring_version, data_source, referring_domains, referring_main_domains,
       total_backlinks, follow_backlinks, nofollow_backlinks, referring_ips, referring_subnets,
       new_backlinks_30d, lost_backlinks_30d, anchor_diversity_score, authority_score,
       score_breakdown, top_linked_pages, raw_summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (site_id, snapshot_date) DO UPDATE SET
       scoring_version = EXCLUDED.scoring_version, data_source = EXCLUDED.data_source,
       referring_domains = EXCLUDED.referring_domains,
       referring_main_domains = EXCLUDED.referring_main_domains, total_backlinks = EXCLUDED.total_backlinks,
       follow_backlinks = EXCLUDED.follow_backlinks, nofollow_backlinks = EXCLUDED.nofollow_backlinks,
       referring_ips = EXCLUDED.referring_ips, referring_subnets = EXCLUDED.referring_subnets,
       new_backlinks_30d = EXCLUDED.new_backlinks_30d, lost_backlinks_30d = EXCLUDED.lost_backlinks_30d,
       anchor_diversity_score = EXCLUDED.anchor_diversity_score, authority_score = EXCLUDED.authority_score,
       score_breakdown = EXCLUDED.score_breakdown, top_linked_pages = EXCLUDED.top_linked_pages,
       raw_summary = EXCLUDED.raw_summary
     RETURNING *`,
    [
      siteId, snapshotDate, data.scoringVersion, data.dataSource, data.referringDomains ?? null, data.referringMainDomains ?? null,
      data.totalBacklinks ?? null, data.followBacklinks ?? null, data.nofollowBacklinks ?? null,
      data.referringIps ?? null, data.referringSubnets ?? null, data.newBacklinks30d ?? null,
      data.lostBacklinks30d ?? null, data.anchorDiversityScore ?? null, data.authorityScore,
      JSON.stringify(data.scoreBreakdown), JSON.stringify(data.topLinkedPages ?? null), JSON.stringify(data.rawSummary ?? null),
    ]
  );
  return rows[0];
}
