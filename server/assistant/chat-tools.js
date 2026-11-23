import { invokeCapability } from './capabilities.js';
import { getLatestFindings } from '../agents/lib/fresh-runs.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';
import { PRIORITY_RANK } from '../agents/orchestrator.js';
import { getRangeTotals, getSearchPerformanceRange, getScreenDataRange } from '../store/read.js';
import { PLATFORM_GUIDE } from '../agents/lib/platform-guide.js';

// The things the Agent chat's AI may look up while it answers. Every one is READ-ONLY, and none takes a site id: the project is
// fixed by the logged-in session (ctx.siteId) and closed over here, so nothing the model writes can reach another project's data.
// The model is told to take every number from these results, never from memory; only the wording is its own.

const MAX_RESULT_CHARS = 6000;
const day = (offset, from = new Date()) => { const d = new Date(from); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const clampDays = (v, dflt = 28) => Math.min(90, Math.max(1, Math.round(Number(v) || dflt)));

// name -> { description, parameters, label (shown while it runs), capability? }
const TOOLS = {
  get_pr_activity: {
    capability: 'get_pr_activity', label: 'Checking your pull requests…',
    description: 'Pull requests on the site\'s repository: opened, merged, and still open. Use for any question about PRs, merges or what went live.',
    parameters: { type: 'object', properties: { period: { type: 'string', enum: ['today', 'yesterday', 'week'], description: 'Default today.' } } },
  },
  get_needs_you: {
    capability: 'get_needs_you', label: 'Checking what is waiting for you…',
    description: 'Everything waiting on the person: approvals to give, issues, and setup questions needing an answer.',
    parameters: { type: 'object', properties: {} },
  },
  get_week_summary: {
    capability: 'get_week_summary', label: 'Checking what went live…',
    description: 'What went live on the site in the last 7 days, by type of change.',
    parameters: { type: 'object', properties: {} },
  },
  get_pending_approvals: {
    capability: 'get_pending_approvals', label: 'Checking approvals…',
    description: 'Fixes and content waiting for the person\'s approval in the Action Center.',
    parameters: { type: 'object', properties: {} },
  },
  get_autonomy_summary: {
    capability: 'get_autonomy_summary', label: 'Checking what is safe to fix automatically…',
    description: 'Which open issues are safe to fix automatically, which need review, and why.',
    parameters: { type: 'object', properties: {} },
  },
  get_agent_status: {
    capability: 'get_agent_status', label: 'Checking recent activity…',
    description: 'What the automated agents did recently and how their latest runs went.',
    parameters: { type: 'object', properties: {} },
  },
  get_failures: {
    capability: 'get_failures', label: 'Checking for failures…',
    description: 'Recent failed jobs and why they failed.',
    parameters: { type: 'object', properties: {} },
  },
  get_findings: {
    label: 'Reading the latest analysis…',
    description: 'The most important issues and opportunities from the latest stored analysis of the site (SEO, AI visibility, content, technical), most important first, with how old the analysis is.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many, 1-15. Default 8.' } } },
  },
  get_traffic: {
    label: 'Looking at your search data…',
    description: 'Search clicks, impressions, average position and visits for the last N days, compared with the N days before. Ends on the newest day that has data, the same as the Overview page, so the numbers match what the person sees there.',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: '1-90. Default 28.' } } },
  },
  get_top_queries: {
    label: 'Looking at your search data…',
    description: 'The searches that bring the most clicks, with impressions and average position, for the last N days.',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: '1-90. Default 28.' }, limit: { type: 'integer', description: '1-20. Default 10.' } } },
  },
  get_platform_guide: {
    label: 'Looking that up…',
    description: 'How to use this dashboard: what each page and button does, how approving and shipping a fix works. Use for "how do I…" questions about the app itself.',
    parameters: { type: 'object', properties: {} },
  },
};

export const toolDefs = () => Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
export const toolLabel = (name) => TOOLS[name]?.label || 'Looking that up…';

// The newest stored findings, most important first. Findings carry no agent names for a client (the model must never say them);
// a platform admin also gets the agent id, since for them that vocabulary is useful. `cited` keeps each finding's real evidence
// object (not the shortened text the model sees) for the "Generate draft" cards under the answer.
async function findingsTool(ctx, args, deps) {
  const limit = Math.min(15, Math.max(1, Math.round(Number(args.limit) || 8)));
  const runs = await (deps.getLatestFindings || getLatestFindings)(ctx.siteId, RECOMMENDATION_AGENT_IDS);
  const all = runs.flatMap((r) => (r.findings || []).map((f) => ({ ...f, agentId: r.agentId })))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  const times = runs.map((r) => new Date(r.createdAt).getTime()).filter(Number.isFinite);
  const top = all.slice(0, limit);
  return {
    data: {
      asOf: times.length ? new Date(Math.min(...times)).toISOString() : null,
      totalFindings: all.length,
      findings: top.map((f) => ({
        id: f.id, priority: f.priority, whyItMatters: f.whyItMatters,
        suggestedFix: f.recommendedAction?.label || null,
        evidence: JSON.stringify(f.evidence ?? null).slice(0, 300),
        ...(ctx.role === 'platform_admin' ? { agent: f.agentId } : {}),
      })),
    },
    cited: top.slice(0, 5).map((f) => ({ id: f.id, whyItMatters: f.whyItMatters, evidence: f.evidence })),
  };
}

// The window ends on the newest day that has data, exactly as the Overview page does (getScreenDataRange), so a number said in
// chat is the number on screen. The "previous" window is the same length, immediately before.
async function dataEnd(ctx, deps) {
  const range = await (deps.getScreenDataRange || getScreenDataRange)(ctx.siteId);
  return range?.freshest || null;
}
const shiftDay = (ymd, n) => day(n, new Date(`${ymd}T00:00:00Z`));

async function trafficTool(ctx, args, deps) {
  const days = clampDays(args.days);
  const end = await dataEnd(ctx, deps);
  if (!end) return { available: false, reason: 'No search data has been collected for this site yet.' };
  const recent = { start: shiftDay(end, -(days - 1)), end };
  const prior = { start: shiftDay(end, -(2 * days - 1)), end: shiftDay(end, -days) };
  const totals = deps.getRangeTotals || getRangeTotals;
  const [a, b] = await Promise.all([totals(ctx.siteId, recent.start, recent.end), totals(ctx.siteId, prior.start, prior.end)]);
  const shape = (t) => ({ clicks: Number(t?.clicks) || 0, impressions: Number(t?.impressions) || 0, avgPosition: t?.avg_position == null ? null : Number(t.avg_position), visitors: Number(t?.users) || 0, sessions: Number(t?.sessions) || 0 });
  return { days, recent: { ...recent, ...shape(a) }, previous: { ...prior, ...shape(b) } };
}

async function queriesTool(ctx, args, deps) {
  const days = clampDays(args.days);
  const limit = Math.min(20, Math.max(1, Math.round(Number(args.limit) || 10)));
  const end = await dataEnd(ctx, deps);
  if (!end) return { available: false, reason: 'No search data has been collected for this site yet.' };
  const start = shiftDay(end, -(days - 1));
  const rows = await (deps.getSearchPerformanceRange || getSearchPerformanceRange)(ctx.siteId, start, end, 'query', limit);
  return {
    days, start, end,
    queries: rows.slice(0, limit).map((r) => ({ query: r.dim_value, clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, avgPosition: r.avg_position == null ? null : Number(r.avg_position) })),
  };
}

/**
 * Runs one tool call and returns { content: string for the model, cited: findings to show as "Generate draft" cards }.
 * Never throws: a failing tool tells the model so, and the model says so, instead of the whole answer failing.
 */
export async function runTool(name, args, ctx, deps = {}) {
  const tool = TOOLS[name];
  if (!tool) return { content: JSON.stringify({ error: 'unknown tool' }), cited: [] };
  try {
    let data;
    let cited = [];
    if (tool.capability) {
      const r = await (deps.invokeCapability || invokeCapability)(tool.capability, ctx, args || {}, deps.capDeps || {});
      if (!r.ok) return { content: JSON.stringify({ error: r.remedy || r.error || 'not available' }), cited: [] };
      data = r.data;
    } else if (name === 'get_findings') {
      ({ data, cited } = await findingsTool(ctx, args || {}, deps));
    } else if (name === 'get_traffic') data = await trafficTool(ctx, args || {}, deps);
    else if (name === 'get_top_queries') data = await queriesTool(ctx, args || {}, deps);
    else if (name === 'get_platform_guide') data = { guide: PLATFORM_GUIDE };
    let content = JSON.stringify(data ?? null);
    if (content.length > MAX_RESULT_CHARS) content = `${content.slice(0, MAX_RESULT_CHARS)}…(shortened)`;
    return { content, cited };
  } catch (err) {
    console.warn(`[chat] tool ${name} failed:`, err.message);
    return { content: JSON.stringify({ error: 'that lookup failed just now' }), cited: [] };
  }
}
