import { getKeywordGaps, getKeywordClusters, getSiteProfile, saveKeywordNarrative } from '../store/data-analyst.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { getQueryPageMetrics, getSiteById } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { callLLM } from '../llm.js';
import { runAgent } from './runner.js';
import { effortForGenerator } from './lib/page-content.js';
import { evidenceWindow } from './lib/duplicate-evidence.js';
import { pickCannibalizationWinner } from './lib/cannibalization-decision.js';

// A page needs at least this much real, non-noise demand before it counts
// as "already covering" a cluster's keywords — same floor
// growth-opportunities.js's MIN_IMPRESSIONS uses for the identical reason:
// a handful of stray impressions on an unrelated page is not evidence the
// topic is covered.
const MIN_CLUSTER_PAGE_IMPRESSIONS = 10;

// Real GSC rows (query, page, clicks, impressions, avgPosition) whose query
// text matches one of this cluster's own keywords, aggregated per landing
// page. Case-insensitive exact match only — no fuzzy/semantic matching,
// since a wrong match here would misroute the whole routing decision below.
function matchedPagesForCluster(keywords, queryPageMetrics) {
  const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));
  const byPage = new Map();
  for (const r of queryPageMetrics) {
    if (!keywordSet.has(r.query.toLowerCase())) continue;
    if (!byPage.has(r.page)) byPage.set(r.page, { page: r.page, clicks: 0, impressions: 0, positionWeighted: 0 });
    const p = byPage.get(r.page);
    p.clicks += r.clicks;
    p.impressions += r.impressions;
    if (r.avgPosition != null) p.positionWeighted += r.avgPosition * r.impressions;
  }
  return [...byPage.values()]
    .map((p) => ({ page: p.page, clicks: p.clicks, impressions: p.impressions, avgPosition: p.impressions ? p.positionWeighted / p.impressions : null }))
    .filter((p) => p.impressions >= MIN_CLUSTER_PAGE_IMPRESSIONS);
}

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
  requiresCapabilities: ['gsc'],
};

// Gathers only real, already-persisted data — no LLM, no fabrication. Shared
// by run() below and generateKeywordNarrative(), so the agent path and the
// cron path can never compute a different picture from the same site.
// Returns null when there is genuinely nothing to narrate yet, which both
// callers translate into their own "nothing happened" shape.
async function collectFacts(siteId) {
  const [gaps, clusters, profile, visibilityRuns, site] = await Promise.all([
    getKeywordGaps(siteId, 'pending_review'),
    getKeywordClusters(siteId),
    getSiteProfile(siteId),
    getLatestAgentRuns(siteId, ['ai-visibility']),
    getSiteById(siteId),
  ]);

  const topGaps = gaps.slice(0, 5);
  const topClusters = [...clusters].sort((a, b) => Number(b.gap_score) - Number(a.gap_score)).slice(0, 5);
  if (topGaps.length === 0 && topClusters.length === 0) return null; // nothing real to narrate yet

  const visibility = visibilityRuns[0]?.facts?.siteScore || null;

  // Same 90-day evidence window every other "which real page owns this"
  // decision in the codebase uses (lib/duplicate-evidence.js) — long enough
  // that zero real matches is trustworthy evidence, not a quiet week.
  const { start, end } = evidenceWindow(site || { timezone: 'UTC' });
  const queryPageMetrics = await getQueryPageMetrics(siteId, start, end);

  return {
    facts: {
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
        keywords: Array.isArray(c.keywords_json) ? c.keywords_json.map((k) => k.keyword).filter(Boolean) : [],
      })),
      aiVisibility: visibility ? { overall: visibility.overall, categories: visibility.categories } : null,
    },
    // Kept OUT of `facts` above deliberately — this is every real
    // query+page row for the whole site over the evidence window, used only
    // to decide each cluster's routing below. Including it in `facts` would
    // mean stringifying it straight into the narrative LLM prompt.
    queryPageMetrics,
  };
}

// findings[] is what the orchestrator, the Copilot, and agentic-orchestrator's
// tool loop actually consume (see agents/types.js) — priority comes from a
// real signal already in facts (the gap's own stored priority; a cluster's
// gap_score relative to the batch), never a constant.
//
// A keyword gap names a topic this site has no page for, which is exactly
// what generators/blog-outline.js drafts — the same shape content-gap.js
// already routes its own AI-suggested gaps through (`{topic, context}`).
// This used to claim no such generator existed and left recommendedAction
// null, so every gap the analyst found died here. Net-new content is still
// gated downstream: a site with no url_file_map.newContentTargets entry for
// blog-outline has the recommendation demoted to the manual tier by
// recommendation-gates.js, visible with a reason, rather than queued.
function buildFindings(facts, queryPageMetrics) {
  const gapFindings = facts.keywordGaps.map((g) => ({
    id: `keyword-narrative:gap:${g.topic}`,
    evidence: { topic: g.topic, reason: g.reason, storedPriority: g.priority },
    whyItMatters: `No page on this site targets "${g.topic}" yet — ${g.reason || 'it was flagged as a gap against the site profile'}.`,
    priority: g.priority === 'high' || g.priority === 'medium' || g.priority === 'low' ? g.priority : 'medium',
    recommendedAction: {
      label: `Cover: ${g.topic}`,
      generatorId: 'blog-outline',
      params: {
        topic: g.topic,
        context: g.reason
          ? `Keyword gap identified against this site's own profile: ${g.reason}`
          : 'Keyword gap identified against this site\'s own profile — no existing page targets this topic.',
      },
      effort: effortForGenerator('blog-outline'),
    },
    expectedImpact: { label: 'Medium', basis: 'estimate' },
  }));

  // Highest gap_score in this batch is the one worth acting on first; the
  // rest are ranked against it rather than against an invented threshold.
  const topScore = facts.contentClusters[0]?.gapScore ?? 0;

  // A cluster's own keywords, matched against real GSC query+page rows,
  // decide the routing the same way growth-opportunities.js/
  // query-intelligence.js already decide theirs from identical evidence —
  // no new signal invented, just wiring this detector onto the page-aware
  // model the rest of the platform already trusts:
  //   0 real matched pages  -> genuinely missing topic -> blog-outline
  //     (same route buildFindings already uses for a keyword gap above).
  //   1 real matched page   -> existing page owns this cluster's traffic
  //     but ranks poorly as a group -> expand-content on that page.
  //   2+ real matched pages -> genuine query-ownership competition ->
  //     pickCannibalizationWinner (same evidence-scored decision
  //     query-intelligence.js's cannibalization findings already use) ->
  //     internal-links toward the evidenced winner, one finding per loser.
  // Only when there is NO real GSC evidence for the site at all in the
  // window does this stay a human reportOnly call — "no page matched" is
  // then indistinguishable from "we haven't ingested enough search data
  // yet", and auto-drafting blog-outline on that silence would be exactly
  // the kind of guess this platform refuses to make.
  const hasSiteEvidence = queryPageMetrics.length > 0;
  const clusterFindings = facts.contentClusters.flatMap((c) => {
    const priority = topScore > 0 && c.gapScore >= topScore * 0.75 ? 'high' : (topScore > 0 && c.gapScore >= topScore * 0.4 ? 'medium' : 'low');

    if (!hasSiteEvidence) {
      return [{
        id: `keyword-narrative:cluster:${c.name}`,
        evidence: { cluster: c.name, type: c.type, gapScore: c.gapScore, avgPosition: c.avgPosition, avgImpressions: c.avgImpressions },
        whyItMatters: `The "${c.name}" cluster has a gap score of ${c.gapScore} on ${Math.round(c.avgImpressions)} impressions, but there is no real Search Console query data for this site in the last evidence window yet.`,
        priority,
        recommendedAction: null,
        reportOnly: {
          kind: 'keyword-cluster-gap',
          label: `"${c.name}" — insufficient search evidence yet`,
          page: '',
          whyBlocked: `No real Search Console query data is available for this site yet, so there isn't enough evidence to decide whether "${c.name}" needs a new page, an existing page expanded, or is already covered — check back once search data has been ingested.`,
        },
        expectedImpact: { label: 'Medium', basis: 'computed', value: c.avgImpressions },
      }];
    }

    const matchedPages = matchedPagesForCluster(c.keywords, queryPageMetrics);

    if (matchedPages.length === 0) {
      return [{
        id: `keyword-narrative:cluster:${c.name}`,
        evidence: { cluster: c.name, type: c.type, gapScore: c.gapScore, avgPosition: c.avgPosition, avgImpressions: c.avgImpressions, matchedPages: [] },
        whyItMatters: `No existing page earns real search traffic for any keyword in the "${c.name}" cluster (${Math.round(c.avgImpressions)} impressions of real demand exist) — this is a missing topic, not an underperforming page.`,
        priority,
        recommendedAction: {
          label: `Cover: ${c.name}`,
          generatorId: 'blog-outline',
          params: {
            topic: c.name,
            context: `Keyword cluster with real search demand (${Math.round(c.avgImpressions)} impressions across its keywords) and no existing page covering any of them.`,
          },
          effort: effortForGenerator('blog-outline'),
        },
        expectedImpact: { label: 'Medium', basis: 'computed', value: c.avgImpressions },
      }];
    }

    if (matchedPages.length === 1) {
      const [owner] = matchedPages;
      return [{
        id: `keyword-narrative:cluster:${c.name}`,
        evidence: { cluster: c.name, type: c.type, gapScore: c.gapScore, avgPosition: c.avgPosition, avgImpressions: c.avgImpressions, matchedPages },
        whyItMatters: `The "${c.name}" cluster's real search traffic already lands on one existing page (${owner.page}, ${owner.impressions} impressions${owner.avgPosition != null ? ` at position ${owner.avgPosition.toFixed(1)}` : ''}) that ranks poorly as a group — expanding that page's own coverage is the safe fix, not a new competing page.`,
        priority,
        recommendedAction: {
          label: `Expand ${owner.page} to cover "${c.name}" more completely`,
          generatorId: 'expand-content',
          params: { page: owner.page },
        },
        expectedImpact: { label: 'Medium', basis: 'computed', value: owner.impressions },
      }];
    }

    const { winner, losers, scoring } = pickCannibalizationWinner(c.name, matchedPages);
    return losers.map((loserPage) => ({
      id: `keyword-narrative:cluster:${c.name}:${loserPage}`,
      evidence: { cluster: c.name, type: c.type, gapScore: c.gapScore, avgPosition: c.avgPosition, avgImpressions: c.avgImpressions, matchedPages, winner, scoring },
      whyItMatters: `${matchedPages.length} existing pages already independently earn real search traffic for the "${c.name}" cluster's keywords, splitting its ranking signal — real evidence (clicks, position, URL relevance) favors ${winner} as the owner.`,
      priority,
      recommendedAction: {
        label: `Strengthen internal linking to the page that should own "${c.name}"`,
        generatorId: 'internal-links',
        params: { page: loserPage, mustLinkTo: winner },
      },
      expectedImpact: { label: 'Medium', basis: 'computed', value: c.avgImpressions },
    }));
  });

  return [...gapFindings, ...clusterFindings];
}

// The registered-agent entry point (agents/types.js's AgentInput ->
// AgentOutput contract). Before this existed the module lived in
// server/agents/ without meta/run, so registry.js logged
// "skipping keyword-narrative.js" on every load and the agent was invisible
// to orchestrator.js, the Copilot, and agentic-orchestrator.js's tool loop —
// the LLM there builds its tool list from listAgentMeta(), so it could never
// call keyword narrative no matter how relevant the question. The cron path
// below now calls this directly too (via runAgent), instead of a separate
// duplicate-work path — see that function's comment.
export async function run({ siteId }) {
  const collected = await collectFacts(siteId);
  if (!collected) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No keyword gaps or content clusters have been computed for this site yet — the data-analyst pipeline needs to run first.',
      generatedAt: new Date().toISOString(),
    };
  }
  const { facts, queryPageMetrics } = collected;

  const narrative = await callLLM(SYSTEM_PROMPT, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 400 })
    .catch((err) => { console.warn('[agents] keyword-narrative narrative failed:', err.message); return null; });

  // Dashboard-read side effect lives here now, not in a second parallel
  // code path — see runKeywordNarrativeForAllSites below for why.
  if (narrative) await saveKeywordNarrative(siteId, narrative);

  return {
    meta, status: 'ok',
    facts: { ...facts, findings: buildFindings(facts, queryPageMetrics) },
    narrative,
    generatedAt: new Date().toISOString(),
  };
}

// Cron entry point (server/cron.js's 14-day keyword-narrative schedule).
// Previously called a separate generateKeywordNarrative() that duplicated
// collectFacts()+callLLM() and wrote ONLY saveKeywordNarrative — it never
// went through agents/runner.js's runAgent(), so this cron firing (even
// successfully, every 14 days) never wrote an agent_runs row. That's why
// the Agent Taskforce showed "Never run" for this agent regardless of
// whether the cron had actually fired — routing through runAgent() here
// fixes both the missing history AND the double LLM call the two parallel
// paths used to make for the same site on the same tick.
export async function runKeywordNarrativeForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      const output = await runAgent('keyword-narrative', { siteId: site.id }, { persist: true });
      results.push({ siteId: site.id, status: output.status });
    } catch (err) {
      console.error(`[keyword-narrative] site ${site.id} "${site.name}" failed:`, err.message);
      results.push({ siteId: site.id, status: 'error' });
    }
  }
  return results;
}
