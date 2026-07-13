import { getAgent } from '../registry.js';
import { getLatestAgentRuns, getLatestFindings } from '../../store/agent-runs.js';

// The 7 specialist agents whose output carries real, per-item structured
// findings (agents/types.js `Finding`) — shared by Action Center (draft
// generation, internal-only) and the client-facing Reports page (read-only
// display). executive-report is excluded: it synthesizes these same 7
// agents' findings into its own topFindings, so including it here would
// double-count every finding under two agent ids.
export const RECOMMENDATION_AGENT_IDS = ['query-intelligence', 'opportunity', 'country-intelligence', 'device-intelligence', 'ai-visibility', 'content-gap', 'competitor-intelligence'];

// Findings from these agents are inherently upside-framed (growth,
// striking-distance, localization), as opposed to problem-framed. Shared by
// the Command Center's Growth Opportunities section and the Opportunity
// Watchlist (agents/lib/watchlist.js) — the single place that defines what
// "an opportunity" means today. A future seasonal-opportunity agent (see
// watchlist.js's `opportunity_type` column) extends this list, not a
// parallel one — one growth taxonomy, not two.
export const OPPORTUNITY_AGENT_IDS = ['opportunity', 'country-intelligence'];

const firstSentence = (text) => (text || '').trim().split(/(?<=[.!?])\s+/)[0] || '';

// Replace a full URL with just its path (or hostname if it's the root) —
// keeps card headlines scannable instead of wrapping a long raw URL.
function shortenUrls(text) {
  return (text || '').replace(/https?:\/\/\S+/g, (url) => {
    try {
      const u = new URL(url);
      return (u.pathname === '/' ? u.hostname : u.pathname).replace(/\/$/, '') || u.hostname;
    } catch {
      return url;
    }
  });
}

// A short, scannable headline for a card: first sentence, URLs shortened,
// hard-capped so a single long run-on sentence from the LLM (no earlier
// sentence break) can't blow out the card's height.
const MAX_HEADLINE = 140;
function headlineFrom(narrative) {
  const clean = shortenUrls(firstSentence(narrative));
  if (!clean) return null;
  return clean.length <= MAX_HEADLINE ? clean : `${clean.slice(0, MAX_HEADLINE - 1).trimEnd()}…`;
}

async function statFor(agentId, facts) {
  if (agentId === 'opportunity') return `${facts.count} opportunit${facts.count === 1 ? 'y' : 'ies'}`;
  if (agentId === 'ai-visibility') return facts.siteScore ? `${facts.siteScore.overall}/100 AI visibility` : null;
  if (agentId === 'content-gap') return `${facts.count} page${facts.count === 1 ? '' : 's'} analyzed`;
  if (agentId === 'country-intelligence') {
    const top = facts.growingMarkets?.[0];
    return top ? `${top.country} +${top.delta} sessions` : null;
  }
  if (agentId === 'query-intelligence') {
    const up = facts.gainers?.length || 0, down = facts.droppers?.length || 0;
    return up || down ? `${up} up · ${down} down` : null;
  }
  if (agentId === 'device-intelligence') {
    return facts.lowCtrDevices?.length ? `${facts.lowCtrDevices.length} low-CTR device${facts.lowCtrDevices.length === 1 ? '' : 's'}` : null;
  }
  return null;
}

// One persisted run per agent id (or null if never run), keyed by agent id.
async function latestRunsById(siteId, agentIds) {
  const runs = await getLatestAgentRuns(siteId, agentIds);
  return new Map(runs.map((r) => [r.agent_id, r]));
}

// Read-only summaries of the latest persisted agent runs — never triggers a
// run. "AI Growth runs agents; Reports consumes the results" — this is the
// consuming side.
export async function getAgentFindings(siteId) {
  const byId = await latestRunsById(siteId, RECOMMENDATION_AGENT_IDS);
  const findings = [];
  for (const agentId of RECOMMENDATION_AGENT_IDS) {
    const run = byId.get(agentId);
    if (!run || run.status !== 'ok' || !run.narrative) continue;
    const agent = await getAgent(agentId);
    findings.push({
      agentId,
      category: agent?.meta?.category || 'seo',
      name: agent?.meta?.name || agentId,
      stat: await statFor(agentId, run.facts || {}),
      headline: headlineFrom(run.narrative),
      narrative: run.narrative,
      generatedAt: run.created_at,
    });
  }
  return findings;
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Read-only, client-safe recommendation list — reads priority/impact/effort
// straight off each agent's own structured `findings[]` (agents/types.js
// Finding) instead of re-deriving them with fixed per-source constants, and
// reads generatorId directly off `recommendedAction` instead of guessing it
// from tag text downstream. Unlike Action Center's buildRecommendations(),
// no generatorId/params are exposed (those stay internal, draft-generation-
// only) — findings with no recommendedAction (e.g. query/device-
// intelligence's evidence-only findings, which have no matching generator)
// are skipped, same as before this agent pair had no recommendation-shaped
// output at all.
export async function getPriorityRecommendations(siteId, limit = 6) {
  const runs = await getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS);
  const bySource = new Map();
  for (const run of runs) {
    const agent = await getAgent(run.agentId);
    const category = agent?.meta?.category || 'seo';
    const items = run.findings
      .filter((f) => f.recommendedAction)
      .map((f) => ({
        id: f.id, source: run.agentId, category,
        title: f.recommendedAction.label, reason: f.whyItMatters,
        impact: f.expectedImpact?.label || 'Medium',
        effort: f.recommendedAction.effort || 'Medium',
        priority: f.priority,
      }));
    if (items.length) bySource.set(run.agentId, items);
  }

  // Cap per-source before the final ranking so one agent with many low-signal
  // findings (e.g. dozens of "missing alt text" gaps) can't crowd out the
  // other agents entirely — the list should read as multi-agent, not
  // single-agent-with-noise.
  const perSourceCap = Math.max(2, Math.ceil(limit / RECOMMENDATION_AGENT_IDS.length));
  const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const capped = [...bySource.values()].flatMap((sourceItems) => sourceItems.sort(byPriority).slice(0, perSourceCap));
  return capped.sort(byPriority).slice(0, limit).map(({ priority, source, ...item }) => item);
}
