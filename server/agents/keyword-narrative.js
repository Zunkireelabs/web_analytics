import { getKeywordGaps, getKeywordClusters, getSiteProfile, saveKeywordNarrative } from '../store/data-analyst.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { listConnectedSites } from '../job.js';
import { callLLM } from '../llm.js';

const SYSTEM_PROMPT = `You are an SEO and AI visibility analyst.
Write a brief 3 paragraph narrative summary.
Be specific, use real data given to you.
Never invent numbers or keywords.
Keep it under 150 words total.

Paragraph 1 - Keyword Opportunities:
What keyword gaps exist and why they matter.

Paragraph 2 - Content Clusters:
What topics are ranking poorly and need work.

Paragraph 3 - One clear action:
The single most important thing to do this week.

Return only the narrative text. No JSON.
No headers. No bullet points.`;

export const meta = {
  id: 'keyword-narrative',
  name: 'Keyword Narrative Agent',
  description: 'Synthesizes keyword gaps, content clusters, and AI-visibility scores into one narrative on where keyword growth is available and what to do about it this week.',
  category: 'seo',
  version: 1,
};

// Gathers only real, already-persisted data — no LLM, no fabrication. Shared
// by run() below and generateKeywordNarrative(), so the agent path and the
// cron path can never compute a different picture from the same site.
// Returns null when there is genuinely nothing to narrate yet, which both
// callers translate into their own "nothing happened" shape.
async function collectFacts(siteId) {
  const [gaps, clusters, profile, visibilityRuns] = await Promise.all([
    getKeywordGaps(siteId, 'pending_review'),
    getKeywordClusters(siteId),
    getSiteProfile(siteId),
    getLatestAgentRuns(siteId, ['ai-visibility']),
  ]);

  const topGaps = gaps.slice(0, 5);
  const topClusters = [...clusters].sort((a, b) => Number(b.gap_score) - Number(a.gap_score)).slice(0, 5);
  if (topGaps.length === 0 && topClusters.length === 0) return null; // nothing real to narrate yet

  const visibility = visibilityRuns[0]?.facts?.siteScore || null;

  return {
    industry: profile?.industry ?? null,
    mainTopics: profile?.main_topics ?? null,
    siteType: profile?.site_type ?? null,
    keywordGaps: topGaps.map((g) => ({ topic: g.topic, reason: g.reason, priority: g.priority })),
    contentClusters: topClusters.map((c) => ({
      name: c.cluster_name,
      type: c.cluster_type,
      gapScore: Number(c.gap_score),
      avgPosition: c.avg_position != null ? Number(c.avg_position) : null,
      avgImpressions: Number(c.avg_impressions),
    })),
    aiVisibility: visibility ? { overall: visibility.overall, categories: visibility.categories } : null,
  };
}

// findings[] is what the orchestrator, the Copilot, and agentic-orchestrator's
// tool loop actually consume (see agents/types.js) — priority comes from a
// real signal already in facts (the gap's own stored priority; a cluster's
// gap_score relative to the batch), never a constant. recommendedAction is
// null throughout: a keyword gap names a topic to write about, and no
// generator in generators/registry.js drafts net-new topical content from a
// bare topic today. Stating that honestly beats pointing at a generator that
// would produce something unrelated.
function buildFindings(facts) {
  const gapFindings = facts.keywordGaps.map((g) => ({
    id: `keyword-narrative:gap:${g.topic}`,
    evidence: { topic: g.topic, reason: g.reason, storedPriority: g.priority },
    whyItMatters: `No page on this site targets "${g.topic}" yet — ${g.reason || 'it was flagged as a gap against the site profile'}.`,
    priority: g.priority === 'high' || g.priority === 'medium' || g.priority === 'low' ? g.priority : 'medium',
    recommendedAction: null,
    expectedImpact: { label: 'Medium', basis: 'estimate' },
  }));

  // Highest gap_score in this batch is the one worth acting on first; the
  // rest are ranked against it rather than against an invented threshold.
  const topScore = facts.contentClusters[0]?.gapScore ?? 0;
  const clusterFindings = facts.contentClusters.map((c) => ({
    id: `keyword-narrative:cluster:${c.name}`,
    evidence: { cluster: c.name, type: c.type, gapScore: c.gapScore, avgPosition: c.avgPosition, avgImpressions: c.avgImpressions },
    whyItMatters: c.avgPosition != null
      ? `The "${c.name}" cluster averages position ${c.avgPosition.toFixed(1)} on ${Math.round(c.avgImpressions)} impressions — real demand this site already sees but doesn't rank well for.`
      : `The "${c.name}" cluster has a gap score of ${c.gapScore} on ${Math.round(c.avgImpressions)} impressions but no ranking position yet.`,
    priority: topScore > 0 && c.gapScore >= topScore * 0.75 ? 'high' : (topScore > 0 && c.gapScore >= topScore * 0.4 ? 'medium' : 'low'),
    recommendedAction: null,
    expectedImpact: { label: 'Medium', basis: 'computed', value: c.avgImpressions },
  }));

  return [...gapFindings, ...clusterFindings];
}

// The registered-agent entry point (agents/types.js's AgentInput ->
// AgentOutput contract). Before this existed the module lived in
// server/agents/ without meta/run, so registry.js logged
// "skipping keyword-narrative.js" on every load and the agent was invisible
// to orchestrator.js, the Copilot, and agentic-orchestrator.js's tool loop —
// the LLM there builds its tool list from listAgentMeta(), so it could never
// call keyword narrative no matter how relevant the question. It ran only via
// the cron path below.
export async function run({ siteId }) {
  const facts = await collectFacts(siteId);
  if (!facts) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No keyword gaps or content clusters have been computed for this site yet — the data-analyst pipeline needs to run first.',
      generatedAt: new Date().toISOString(),
    };
  }

  const narrative = await callLLM(SYSTEM_PROMPT, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 400 })
    .catch((err) => { console.warn('[agents] keyword-narrative narrative failed:', err.message); return null; });

  return {
    meta, status: 'ok',
    facts: { ...facts, findings: buildFindings(facts) },
    narrative,
    generatedAt: new Date().toISOString(),
  };
}

// Supplementary to the Python executive-summary pipeline in data-analyst-agent/
// (never imported by it, never imports from it) — synthesizes keyword-gap,
// clustering, and AI-visibility data that pipeline doesn't currently read.
//
// Kept as its own export rather than folded into run(): this one PERSISTS the
// narrative via saveKeywordNarrative (the dashboard reads that row), whereas
// run() returns it for the caller to do with as it likes and lets
// agents/runner.js persist the agent_runs history row. Same facts, two
// different destinations.
export async function generateKeywordNarrative(siteId) {
  const facts = await collectFacts(siteId);
  if (!facts) return null;

  const narrative = await callLLM(SYSTEM_PROMPT, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 400 });
  await saveKeywordNarrative(siteId, narrative);
  return narrative;
}

export async function runKeywordNarrativeForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      const narrative = await generateKeywordNarrative(site.id);
      results.push({ siteId: site.id, status: narrative ? 'ok' : 'skipped' });
    } catch (err) {
      console.error(`[keyword-narrative] site ${site.id} "${site.name}" failed:`, err.message);
      results.push({ siteId: site.id, status: 'error' });
    }
  }
  return results;
}
