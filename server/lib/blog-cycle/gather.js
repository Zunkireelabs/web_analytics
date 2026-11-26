// Collects the real data the evidence gate judges, for ONE topic of ONE project. Every source is injectable; any source that fails is reported as
// unavailable (never silently treated as "nothing found"): the gate then holds the topic instead of guessing.
import { topicTokens } from '../content-index/normalize.js';

async function defaultDeps() {
  const [da, cov] = await Promise.all([import('../../store/data-analyst.js'), import('../../agents/lib/keyword-coverage-service.js')]);
  return {
    relatedQueries: (siteId, topic) => da.getRelatedQueriesForTopic(siteId, topic, 90, 8),
    rankingPages: (siteId, tokens) => da.getPagesRankingForTokens(siteId, tokens, 90, 200),
    coverage: (siteId, topic) => cov.classifyGapCoverage(siteId, { topic }, { allowLLM: false, persist: false }),
    keywordGap: async (siteId, topic) => {
      const { query } = await import('../../db.js');
      const { rows } = await query(`SELECT search_volume, competitor_evidence, source FROM keyword_gaps WHERE site_id = $1 AND lower(topic) = lower($2) ORDER BY id DESC LIMIT 1`, [siteId, topic]);
      return rows[0] || null;
    },
  };
}

/**
 * @param {number} siteId @param {object} rec the open blog recommendation (params, detecting_agents) @param {string} topic
 * @returns {Promise<{ gsc, demand, coverage, signals }>}
 */
export async function gatherTopicEvidence(siteId, rec, topic, { deps = null } = {}) {
  const d = deps || await defaultDeps();
  const tokens = topicTokens(topic);
  const gsc = { relatedQueries: [], rankingPages: [] };
  try {
    const [related, ranking] = await Promise.all([d.relatedQueries(siteId, topic), d.rankingPages(siteId, tokens)]);
    gsc.relatedQueries = (related || []).map((r) => ({ query: r.dim_value ?? r.query, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, position: r.avg_position == null ? null : Number(r.avg_position) }));
    gsc.rankingPages = (ranking || []).map((r) => ({ page: r.page, query: r.query, impressions: Number(r.impressions) || 0, position: r.position == null ? null : Number(r.position) }));
  } catch (err) { gsc.unavailable = String(err.message || err).slice(0, 120); }

  let coverage = null;
  try { const c = await d.coverage(siteId, topic); coverage = c ? { status: c.status, url: c.url || null } : null; } catch { coverage = null; }

  let gap = null;
  try { gap = await d.keywordGap(siteId, topic); } catch { gap = null; }
  const demand = gap?.search_volume != null ? { searchVolume: Number(gap.search_volume) } : (rec?.params?.searchVolume != null ? { searchVolume: Number(rec.params.searchVolume) } : null);
  const signals = {
    competitor: !!(gap?.competitor_evidence && Object.keys(gap.competitor_evidence).length) || rec?.params?.opportunityType === 'competitor',
    trend: rec?.params?.category === 'Insights' || (rec?.detecting_agents || []).includes('trend-radar'),
    detectors: rec?.detecting_agents || [],
  };
  return { gsc, demand, coverage, signals };
}
