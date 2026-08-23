import { z } from 'zod';
import {
  getSiteById, getDataRange, getDailySeries, getRangeTotals, getMonthlyTotals,
  getChannelsRange, getChannelsDailySeries, getGscBreakdownRange, getGa4BreakdownRange, getTopMovers,
  getHealthScoreSeries, getGscBreakdownDailySeries, getGa4BreakdownDailySeries, getGscBreakdownDailyTopN,
  getQueryPageMetrics, getCannibalizedQueries,
} from '../../server/store/read.js';
import { translateQuery } from '../../server/report/translate.js';
import { buildReportSummary, buildCountryBreakdown } from '../../server/report/summary.js';
import { listAgentMeta } from '../../server/agents/registry.js';
import { getAgentStatusList } from '../../server/agents/lib/agent-status.js';
import { getAgentActivityFeed, getCommandCenterData } from '../../server/agents/lib/command-center.js';
import { getAgentRunHistory } from '../../server/store/agent-runs.js';
import { getAgenticOrchestrationStatsSince } from '../../server/store/agentic-orchestration-runs.js';
import { listGeneratorMeta } from '../../server/generators/registry.js';
import { listDrafts, getDraft } from '../../server/store/drafts.js';
import { buildRecommendations } from '../../server/agents/lib/recommendations.js';
import { getAuthorityScoreSeries } from '../../server/store/authority.js';
import { getMonthlyMentionRate, getWeeklyMentionRate } from '../../server/store/ai-recommendation.js';
import { getOwnStructuralScoreSeries } from '../../server/store/competitor-profiles.js';
import { getForecasts, getAnomalyAlerts, getSiteProfile, getKeywordClusters, getKeywordGaps } from '../../server/store/data-analyst.js';
import { listPageInventory } from '../../server/store/page-inventory.js';
import { getTechnicalSeoSignalsForPages } from '../../server/store/technical-seo-checks.js';
import { dateStr, jsonResult, withErrorHandling } from './shared.js';

// Read-only analytics/reporting/agent-status/Action-Center-read MCP tools.
// Every tool here is a thin wrapper around the exact same store/lib
// function the equivalent session-authed HTTP route already calls — see
// server/report/summary.js, server/agents/lib/agent-status.js — so the two
// surfaces can never drift apart. Always registered, regardless of tier:
// every tool below is read-only by construction, nothing to gate here.
// Every handler is wrapped in withErrorHandling (shared.js) so an
// unexpected DB/library exception is logged server-side and reported to
// the calling AI client as a generic message, not leaked verbatim.
export function registerReadOnlyTools(server, siteId) {
  server.registerTool('get_site_info', {
    description: "The token's own site — name, domain, connected GSC/GA4 properties, timezone.",
    inputSchema: {},
  }, withErrorHandling('get_site_info', async () => jsonResult(await getSiteById(siteId))));

  server.registerTool('get_data_range', {
    description: 'Earliest, freshest-complete, and latest available data dates for this site.',
    inputSchema: {},
  }, withErrorHandling('get_data_range', async () => jsonResult(await getDataRange(siteId))));

  server.registerTool('get_daily_series', {
    description: 'Daily combined Search Console + GA4 series for a date range.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_daily_series', async ({ start, end }) => jsonResult(await getDailySeries(siteId, start, end))));

  server.registerTool('get_range_totals', {
    description: 'Aggregated clicks/impressions/position/users/sessions totals over a date range.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_range_totals', async ({ start, end }) => jsonResult(await getRangeTotals(siteId, start, end))));

  server.registerTool('get_monthly_totals', {
    description: 'Aggregated totals for one calendar month.',
    inputSchema: { year: z.number().int(), month: z.number().int().min(1).max(12) },
  }, withErrorHandling('get_monthly_totals', async ({ year, month }) => jsonResult(await getMonthlyTotals(siteId, year, month))));

  server.registerTool('get_channels_range', {
    description: 'Traffic by channel (organic, direct, referral, etc.) aggregated over a date range.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_channels_range', async ({ start, end }) => jsonResult(await getChannelsRange(siteId, start, end))));

  server.registerTool('get_channels_daily_series', {
    description: 'Real per-day sessions/users by channel (organic, direct, referral, etc.) over a date range — one row per (day, channel), unaggregated. Distinct from get_channels_range, which sums the whole range into one row per channel.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_channels_daily_series', async ({ start, end }) => jsonResult(await getChannelsDailySeries(siteId, start, end))));

  server.registerTool('get_gsc_breakdown_daily_series', {
    description: 'Real per-day Search Console clicks/impressions/ctr/position by device or country over a date range — one row per (day, dim_value), unaggregated. Distinct from get_gsc_breakdown, which sums the whole range into a top-N list.',
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['device', 'country']) },
  }, withErrorHandling('get_gsc_breakdown_daily_series', async ({ start, end, dim }) => jsonResult(await getGscBreakdownDailySeries(siteId, start, end, dim))));

  server.registerTool('get_ga4_breakdown_daily_series', {
    description: 'Real per-day GA4 sessions/users by device, country, browser, or source/medium over a date range — one row per (day, dim_value), unaggregated. Distinct from get_device_breakdown/get_country_breakdown, which sum the whole range into a top-N list.',
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['device', 'country', 'browser', 'source_medium']) },
  }, withErrorHandling('get_ga4_breakdown_daily_series', async ({ start, end, dim }) => jsonResult(await getGa4BreakdownDailySeries(siteId, start, end, dim))));

  server.registerTool('get_gsc_breakdown_daily_top_n', {
    description: 'Real per-day Search Console clicks/impressions/ctr/position for the top N pages or queries (by clicks) each day over a date range — bounded per day, unlike get_gsc_breakdown_daily_series, since page/query cardinality is unbounded.',
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['page', 'query']), limit: z.number().int().min(1).max(50).default(50) },
  }, withErrorHandling('get_gsc_breakdown_daily_top_n', async ({ start, end, dim, limit }) => jsonResult(await getGscBreakdownDailyTopN(siteId, start, end, dim, limit))));

  server.registerTool('get_gsc_breakdown', {
    description: 'Search Console breakdown (query, page, device, or country) aggregated over a date range.',
    // Cap raised from 50 to 2000 for 'query'/'page' specifically — the
    // keyword-clustering collector (data-analyst-agent/app/collectors/
    // keyword_clustering.py) needs the real keyword universe over a 90-day
    // window to cluster meaningfully, not just a top-10/50 dashboard list.
    // Default stays 10 and every existing caller is unaffected; only a
    // caller that explicitly asks for more now can get it.
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['query', 'page', 'device', 'country']), limit: z.number().int().min(1).max(2000).default(10) },
  }, withErrorHandling('get_gsc_breakdown', async ({ start, end, dim, limit }) => jsonResult(await getGscBreakdownRange(siteId, start, end, dim, limit))));

  server.registerTool('get_ga4_breakdown', {
    description: 'GA4 breakdown (device category, country, city, or language) aggregated over a date range.',
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['deviceCategory', 'country', 'city', 'language']), limit: z.number().int().min(1).max(50).default(10) },
  }, withErrorHandling('get_ga4_breakdown', async ({ start, end, dim, limit }) => jsonResult(await getGa4BreakdownRange(siteId, start, end, dim, limit))));

  server.registerTool('get_device_breakdown', {
    description: 'GA4 sessions/users split by device (mobile/desktop/tablet) over a date range.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_device_breakdown', async ({ start, end }) => jsonResult(await getGa4BreakdownRange(siteId, start, end, 'device', 5))));

  server.registerTool('get_country_breakdown', {
    description: 'GA4 visitors and Search Console clicks/impressions by country over a date range.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_country_breakdown', async ({ start, end }) => jsonResult(await buildCountryBreakdown(siteId, start, end))));

  server.registerTool('get_top_movers', {
    description: 'Search queries with the biggest clicks gain/drop between a recent period and a prior period of the same length.',
    inputSchema: {
      recentStart: dateStr, recentEnd: dateStr,
      priorStart: dateStr, priorEnd: dateStr,
      limit: z.number().int().min(1).max(50).default(8),
    },
  }, withErrorHandling('get_top_movers', async ({ recentStart, recentEnd, priorStart, priorEnd, limit }) =>
    jsonResult(await getTopMovers(siteId, { start: recentStart, end: recentEnd }, { start: priorStart, end: priorEnd }, limit))));

  server.registerTool('translate_query', {
    description: 'Detects the language of a search query and gives a short literal English translation.',
    inputSchema: { query: z.string().min(1) },
  }, withErrorHandling('translate_query', async ({ query }) => jsonResult(await translateQuery(query))));

  server.registerTool('get_report_summary', {
    description: 'The dashboard Reports page content for a period: live metrics, trend series, query movers, recent history, and the matching AI narrative if one has already been generated.',
    inputSchema: { period: z.enum(['daily', 'weekly', 'monthly']) },
  }, withErrorHandling('get_report_summary', async ({ period }) => {
    const site = await getSiteById(siteId);
    if (!site) return { isError: true, content: [{ type: 'text', text: 'Site not found.' }] };
    return jsonResult(await buildReportSummary(site, period));
  }));

  server.registerTool('list_agents', {
    description: 'Every registered growth agent\'s metadata (id, name, description, category, data sources).',
    inputSchema: {},
  }, withErrorHandling('list_agents', async () => jsonResult(await listAgentMeta())));

  server.registerTool('get_agent_status', {
    description: 'Every agent\'s metadata joined with its real latest persisted run for this site (status, last run time, finding count).',
    inputSchema: {},
  }, withErrorHandling('get_agent_status', async () => jsonResult(await getAgentStatusList(siteId))));

  server.registerTool('get_agent_activity', {
    description: 'Real recent runs across every registered agent for this site, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(12) },
  }, withErrorHandling('get_agent_activity', async ({ limit }) => {
    const meta = await listAgentMeta();
    return jsonResult(await getAgentActivityFeed(siteId, meta.map((m) => m.id), limit));
  }));

  server.registerTool('get_agent_runs', {
    description: 'Run history for one specific agent on this site, newest first.',
    inputSchema: { agentId: z.string().min(1), limit: z.number().int().min(1).max(100).default(10) },
  }, withErrorHandling('get_agent_runs', async ({ agentId, limit }) => jsonResult(await getAgentRunHistory(siteId, agentId, limit))));

  server.registerTool('get_command_center', {
    description: 'Everything the AI Command Center\'s primary view shows for this site — reads only already-persisted data, never triggers a live agent run.',
    inputSchema: {},
  }, withErrorHandling('get_command_center', async () => jsonResult(await getCommandCenterData(siteId))));

  server.registerTool('get_agentic_stats', {
    description: 'Agentic orchestration stats (rounds, tool calls, tokens) for this site since a given date.',
    inputSchema: { sinceDate: dateStr },
  }, withErrorHandling('get_agentic_stats', async ({ sinceDate }) => jsonResult(await getAgenticOrchestrationStatsSince(siteId, sinceDate))));

  server.registerTool('list_generators', {
    description: 'Every registered Action Center content generator\'s metadata.',
    inputSchema: {},
  }, withErrorHandling('list_generators', async () => jsonResult(await listGeneratorMeta())));

  server.registerTool('list_drafts', {
    description: 'Action Center drafts for this site, optionally filtered by action type or status.',
    inputSchema: { actionType: z.string().optional(), status: z.string().optional() },
  }, withErrorHandling('list_drafts', async ({ actionType, status }) => jsonResult(await listDrafts(siteId, { actionType, status }))));

  server.registerTool('get_draft', {
    description: 'One Action Center draft by id.',
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('get_draft', async ({ id }) => jsonResult(await getDraft(siteId, id))));

  server.registerTool('get_recommendations', {
    description: 'Action Center recommendations for this site — reads a cached build, never triggers a live refresh.',
    inputSchema: {},
  }, withErrorHandling('get_recommendations', async () => jsonResult(await buildRecommendations(siteId))));

  server.registerTool('get_health_score_series', {
    description: 'Real daily Website Health Score snapshots between two dates, oldest first. Sparse/empty for dates before snapshots existed — never interpolated or backfilled.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_health_score_series', async ({ start, end }) => jsonResult(await getHealthScoreSeries(siteId, start, end))));

  server.registerTool('get_authority_score_series', {
    description: 'Real monthly Authority Score snapshots between two dates, oldest first. Empty if DataForSEO backlink data is not yet configured for this site — never estimated.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_authority_score_series', async ({ start, end }) => jsonResult(await getAuthorityScoreSeries(siteId, start, end))));

  server.registerTool('get_ai_recommendation_visibility_series', {
    description: 'Real AI-engine recommendation mention rate (%), rolled up to calendar month, between two dates, oldest first. Empty if AI recommendation tracking is not enabled for this site.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_ai_recommendation_visibility_series', async ({ start, end }) => jsonResult(await getMonthlyMentionRate(siteId, start, end))));

  server.registerTool('get_ai_recommendation_visibility_weekly_series', {
    description: 'Real AI-engine recommendation mention rate (%), rolled up to calendar week (Monday-start), between two dates, oldest first. Empty if AI recommendation tracking is not enabled for this site.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_ai_recommendation_visibility_weekly_series', async ({ start, end }) => jsonResult(await getWeeklyMentionRate(siteId, start, end))));

  server.registerTool('get_competitor_structural_score_series', {
    description: "Real snapshots of this site's own competitor-structural-readiness score between two dates, oldest first, one value per real run (deduped across the competitor rows written in that run).",
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('get_competitor_structural_score_series', async ({ start, end }) => jsonResult(await getOwnStructuralScoreSeries(siteId, start, end))));

  server.registerTool('get_forecasts', {
    description: "Real forecast predictions for this site from the Data Analyst Agent's nightly forecast engine (forecast_runs/forecast_points) — latest 'ok' run per metric, never computed live. Optionally filtered to one metric and/or bounded to a forecast horizon in days.",
    inputSchema: { metric: z.string().optional(), days: z.number().int().min(1).max(365).optional() },
  }, withErrorHandling('get_forecasts', async ({ metric, days }) => jsonResult(await getForecasts(siteId, metric, days))));

  server.registerTool('get_anomaly_alerts', {
    description: "Real detected anomalies for this site from the Data Analyst Agent's nightly anomaly detection (z-score/IQR), newest first.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, withErrorHandling('get_anomaly_alerts', async ({ limit }) => jsonResult(await getAnomalyAlerts(siteId, limit))));

  server.registerTool('get_site_profile', {
    description: "Claude's current understanding of this site — industry, main topics, site type — inferred from its own real top search queries. Empty until the clustering pipeline has run at least once for this site.",
    inputSchema: {},
  }, withErrorHandling('get_site_profile', async () => jsonResult(await getSiteProfile(siteId))));

  server.registerTool('get_keyword_clusters', {
    description: "Real topic clusters grouping this site's own semantically-similar search queries, from the latest clustering run, newest first. Optionally filtered to one cluster type.",
    inputSchema: { clusterType: z.enum(['service', 'product', 'general']).optional() },
  }, withErrorHandling('get_keyword_clusters', async ({ clusterType }) => jsonResult(await getKeywordClusters(siteId, clusterType))));

  server.registerTool('get_keyword_gaps', {
    description: 'Real keyword topics with zero current coverage, identified from this site\'s own profile and existing clusters — a human-review queue, never auto-applied. Optionally filtered by review status.',
    inputSchema: { status: z.enum(['pending_review', 'approved', 'rejected']).optional() },
  }, withErrorHandling('get_keyword_gaps', async ({ status }) => jsonResult(await getKeywordGaps(siteId, status))));

  // The canonical "every real page we know about" for this site (see
  // page_inventory's own migration comment) — sitemap + a real
  // homepage-outward crawl + GSC's own performance data, merged. This is
  // website STRUCTURE (which URLs exist, how they were discovered, whether
  // a page is orphaned — reachable from nothing else on the site via a real
  // internal link), not page CONTENT: titles/headings/body/schema are
  // computed fresh per-request by Node's own page-content analysis and
  // never persisted anywhere, so there is no existing stored dataset to
  // wrap into a tool here without Node first changing what it persists.
  server.registerTool('get_page_inventory', {
    description: "Every real URL known for this site (from sitemap, a real crawl, and/or GSC), how it was first discovered, and whether it's orphaned (in the sitemap but unreachable via any real internal link found during the last crawl). Newest-seen first.",
    inputSchema: { limit: z.number().int().positive().max(2000).optional() },
  }, withErrorHandling('get_page_inventory', async ({ limit }) => jsonResult(await listPageInventory(siteId, { limit }))));

  // Persisted content/technical signals (migration 120) — title, canonical,
  // schema, index status, broken links, word count, meta description, and
  // internal-link count, all computed by Node's existing page-content/
  // technical-seo pipeline and never re-derived here. Only covers pages this
  // site's technical-seo rotation has already checked (see technical_seo_
  // checks' own migration comment on the bounded-rotation rationale) —
  // absent pages simply aren't in the result, not a false "no issues".
  server.registerTool('get_technical_seo_signals', {
    description: 'Real, already-persisted per-page technical SEO + content signals: title, canonical/schema presence, index status, broken links, word count, meta description, internal link count. Only covers pages already checked by this site\'s technical-seo rotation — a page never checked is simply absent, not "clean". Optionally filtered to specific pages.',
    inputSchema: { pages: z.array(z.string()).max(200).optional(), limit: z.number().int().positive().max(2000).optional() },
  }, withErrorHandling('get_technical_seo_signals', async ({ pages, limit }) => jsonResult(await getTechnicalSeoSignalsForPages(siteId, { pages, limit }))));

  // Real per-(query,page) Search Console evidence (gsc_query_page) — the
  // join get_gsc_breakdown deliberately doesn't have (it aggregates query
  // and page as independent single-dimension rows). This is the same store
  // function server/agents/lib/growth-opportunities.js already uses for the
  // Analyst page's own opportunity surfacing.
  server.registerTool('get_query_page_metrics', {
    description: 'Real Search Console clicks/impressions/CTR/avg-position for every (query, page) pair actually observed together over a date range — the evidence needed to grade a target keyword or judge whether an existing page already covers it. No estimated search volume anywhere in this data.',
    inputSchema: { start: dateStr, end: dateStr, minImpressions: z.number().int().min(0).default(5) },
  }, withErrorHandling('get_query_page_metrics', async ({ start, end, minImpressions }) => jsonResult(await getQueryPageMetrics(siteId, start, end, { minImpressions }))));

  // Real query cannibalization candidates — 2+ of the site's OWN pages both
  // genuinely ranking (real position, real impressions) for the same real
  // query. Same store function server/routes already expose for staff
  // review; here it's read-only evidence for the Analyst to grade further
  // (demand threshold, ownership instability) before treating it as a
  // finding, per this task's evidence-requirement.
  server.registerTool('get_cannibalized_queries', {
    description: 'Real queries where 2+ of this site\'s own pages both rank within a position ceiling over a date range, sorted by combined clicks. Raw candidate evidence only — not itself a finding; requires further grading (demand, ranking stability) before use.',
    inputSchema: {
      start: dateStr, end: dateStr,
      minImpressions: z.number().int().min(0).default(5),
      maxPosition: z.number().int().min(1).max(100).default(20),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, withErrorHandling('get_cannibalized_queries', async ({ start, end, minImpressions, maxPosition, limit }) =>
    jsonResult(await getCannibalizedQueries(siteId, start, end, { minImpressions, maxPosition, limit }))));
}
