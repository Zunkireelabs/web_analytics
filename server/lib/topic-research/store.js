// Database reads and the one write (creating a proposal) behind continuous topic research. Every query carries the site id.
import { query as defaultQuery } from '../../db.js';

/** Weekly impressions per query for the last `weeks` weeks (only queries with enough total impressions to be a signal). */
export async function loadQuerySeries(siteId, { weeks = 12, minTotal = 30, limit = 4000, query = defaultQuery } = {}) {
  const { rows } = await query(
    `WITH s AS (
       SELECT query, date_trunc('week', date)::date AS week, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks
         FROM gsc_query_page WHERE site_id = $1 AND date >= CURRENT_DATE - ($2::int * 7) GROUP BY 1, 2)
     SELECT query, to_char(week, 'YYYY-MM-DD') AS week, impressions, clicks FROM s
      WHERE query IN (SELECT query FROM s GROUP BY query HAVING SUM(impressions) >= $3 ORDER BY SUM(impressions) DESC LIMIT $4)`,
    [siteId, weeks, minTotal, limit]);
  return rows;
}

/** { 'YYYY-MM': impressions } across all stored history (for the seasonality read). */
export async function loadMonthlyTotals(siteId, { query = defaultQuery } = {}) {
  const { rows } = await query(`SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS m, SUM(impressions)::bigint AS n FROM gsc_query_page WHERE site_id = $1 GROUP BY 1 ORDER BY 1`, [siteId]);
  return Object.fromEntries(rows.map((r) => [r.m, Number(r.n)]));
}

/** Map<query, { page, position }>: the best-ranking own page per query over the last `days` days. */
export async function loadBestPages(siteId, { days = 90, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT DISTINCT ON (query) query, page, position FROM (
       SELECT query, page, SUM(impressions) AS imp, ROUND((SUM(position * impressions) / NULLIF(SUM(impressions), 0))::numeric, 2) AS position
         FROM gsc_query_page WHERE site_id = $1 AND date >= CURRENT_DATE - $2::int GROUP BY query, page HAVING SUM(impressions) >= 3) t
      ORDER BY query, position ASC NULLS LAST`, [siteId, days]);
  return new Map(rows.map((r) => [r.query, { page: r.page, position: r.position == null ? null : Number(r.position) }]));
}

export async function loadOpenGaps(siteId, { limit = 300, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT id, topic, status, search_volume, competitor_evidence, coverage_status, recommendation_id, source FROM keyword_gaps
      WHERE site_id = $1 AND status IN ('pending_review', 'approved') AND recommendation_id IS NULL ORDER BY opportunity_score DESC NULLS LAST, id DESC LIMIT $2`, [siteId, limit]);
  return rows;
}

export async function loadOpenBlogTopics(siteId, { query = defaultQuery } = {}) {
  const { rows } = await query(`SELECT params->>'topic' AS topic FROM recommendations WHERE site_id = $1 AND recommendation_type = 'blog-outline' AND status = 'open' AND params->>'topic' IS NOT NULL`, [siteId]);
  return rows.map((r) => r.topic);
}

/**
 * The ready pool: open blog recommendations the evidence gate has accepted (within `days`) that have no live draft yet, i.e. topics ready to be written
 * in the next blog cycle without anyone's approval.
 */
export async function readyPoolCount(siteId, { days = 14, query = defaultQuery } = {}) {
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS n FROM recommendations r
      WHERE r.site_id = $1 AND r.recommendation_type = 'blog-outline' AND r.status = 'open'
        AND EXISTS (SELECT 1 FROM topic_decisions d WHERE d.site_id = r.site_id AND d.recommendation_id = r.id AND d.decision = 'accepted' AND d.created_at > now() - ($2::int * interval '1 day'))
        AND NOT EXISTS (SELECT 1 FROM drafts dr WHERE dr.site_id = r.site_id AND dr.finding_id = ANY(r.finding_ids) AND dr.status <> 'abandoned')`, [siteId, days]);
  return r?.n ?? 0;
}

/** Proposals this project already received from research in the last `days` days (the per-cycle cap). */
export async function recentProposalCount(siteId, { days = 3, query = defaultQuery } = {}) {
  const { rows: [r] } = await query(`SELECT count(*)::int AS n FROM topic_decisions WHERE site_id = $1 AND origin = 'research' AND decision = 'accepted' AND enforced AND created_at > now() - ($2::int * interval '1 day')`, [siteId, days]);
  return r?.n ?? 0;
}

/**
 * Turns an accepted topic into a real blog recommendation the normal way: a keyword-gap row, approved, then the standard recommendation creator (so
 * every existing gate still applies: new-content target, coverage, eligibility). Returns { recommendationId } or { eligible: false, ... }.
 */
export async function createProposal(siteId, candidate, { reason = null, deps = null } = {}) {
  const d = deps || {
    saveKeywordGaps: (await import('../../store/data-analyst.js')).saveKeywordGaps,
    updateKeywordGapStatus: (await import('../../store/data-analyst.js')).updateKeywordGapStatus,
    create: (await import('../../agents/lib/analyst-seo-mapping.js')).createActionCenterRecommendationForGap,
    // Same link the keyword schedule writes (keyword-schedule.js queueOne): the gap now has its recommendation, so it is never proposed again.
    linkGap: async (gapId, recommendationId) => { await defaultQuery(`UPDATE keyword_gaps SET recommendation_id = $3 WHERE site_id = $1 AND id = $2`, [siteId, gapId, recommendationId]); },
    findGap: async (id, topic) => {
      const { rows } = await defaultQuery(`SELECT * FROM keyword_gaps WHERE site_id = $1 AND (($2::int IS NOT NULL AND id = $2) OR lower(topic) = lower($3)) AND status = 'pending_review' ORDER BY id DESC LIMIT 1`, [siteId, id ?? null, candidate.topic]);
      return rows[0] || null;
    },
  };
  let gapId = candidate.gapId ?? null;
  if (gapId == null) {
    await d.saveKeywordGaps(siteId, [{ topic: candidate.topic, reason: reason || 'Chosen by topic research from real search data.', priority: 'medium', search_volume: candidate.demand?.searchVolume ?? null }], 'internal_analysis');
  }
  const gap = await d.findGap(gapId, candidate.topic);
  if (!gap) return { eligible: false, reason: 'the keyword-gap row could not be created or found' };
  const updated = await d.updateKeywordGapStatus(siteId, gap.id, 'approved');
  const created = await d.create(siteId, { ...gap, ...(updated || {}), _scheduled: true }, { deferDraft: true });
  if (created?.recommendationId) {
    await d.linkGap?.(gap.id, created.recommendationId).catch(() => {});
    return { eligible: true, recommendationId: created.recommendationId, gapId: gap.id };
  }
  return { eligible: false, gapId: gap.id, reason: created?.dropped || 'not shippable by the standard creator' };
}
