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

// Supplementary to the Python executive-summary pipeline in data-analyst-agent/
// (never imported by it, never imports from it) — synthesizes keyword-gap,
// clustering, and AI-visibility data that pipeline doesn't currently read.
export async function generateKeywordNarrative(siteId) {
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

  const facts = {
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
