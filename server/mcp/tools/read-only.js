import { z } from 'zod';
import {
  getSiteById, getDataRange, getDailySeries, getRangeTotals, getMonthlyTotals,
  getChannelsRange, getGscBreakdownRange, getGa4BreakdownRange, getTopMovers,
  getHealthScoreSeries,
} from '../../store/read.js';
import { translateQuery } from '../../report/translate.js';
import { buildReportSummary, buildCountryBreakdown } from '../../report/summary.js';
import { listAgentMeta } from '../../agents/registry.js';
import { getAgentStatusList } from '../../agents/lib/agent-status.js';
import { getAgentActivityFeed, getCommandCenterData } from '../../agents/lib/command-center.js';
import { getAgentRunHistory } from '../../store/agent-runs.js';
import { getAgenticOrchestrationStatsSince } from '../../store/agentic-orchestration-runs.js';
import { listGeneratorMeta } from '../../generators/registry.js';
import { listDrafts, getDraft } from '../../store/drafts.js';
import { buildRecommendations } from '../../agents/lib/recommendations.js';
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

  server.registerTool('get_gsc_breakdown', {
    description: 'Search Console breakdown (query, page, device, or country) aggregated over a date range.',
    inputSchema: { start: dateStr, end: dateStr, dim: z.enum(['query', 'page', 'device', 'country']), limit: z.number().int().min(1).max(50).default(10) },
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
}
