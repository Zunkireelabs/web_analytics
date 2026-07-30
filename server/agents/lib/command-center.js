import { listAgentMeta } from '../registry.js';
import { getLatestFindings, getLatestAgentRuns } from './fresh-runs.js';
import { getRecentActivity } from '../../store/agent-runs.js';
import { getHealthScoreOnOrBefore } from '../../store/read.js';
import { saveHealthScoreSnapshot } from '../../store/upsert.js';
import { computeHealthScore } from './health-score.js';
import { RECOMMENDATION_AGENT_IDS, OPPORTUNITY_AGENT_IDS } from './insights.js';
import { buildRecommendations } from './recommendations.js';
import { getFindingsDiff, healthChangeEntry } from './changes.js';
import { listWatchlist } from '../../store/watchlist.js';
import { listCompetitorProfiles } from '../../store/competitor-profiles.js';
import { getAuthoritySnapshotHistory } from '../../store/authority.js';
import { getMentionRateHistory } from '../../store/ai-recommendation.js';
import { PROVIDERS } from './model-providers/index.js';
import { getImplementedFindingIds } from '../../store/drafts.js';
import { competitorProviderConfigured } from '../../ingest/competitor-providers/index.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const OPEN_WATCHLIST_STATUSES = new Set(['new', 'in_progress']);

// Every line in the AI Activity feed is real, worked-completed text — no
// "competitor monitoring" or anything not actually built (see
// dataSources: not-connected on ai-visibility/content-gap's own meta).
const ACTIVITY_LABEL = {
  'query-intelligence': 'Analyzed search queries for gainers and droppers',
  opportunity: 'Detected striking-distance ranking opportunities',
  'country-intelligence': 'Reviewed geographic performance for anomalies',
  'device-intelligence': 'Reviewed device-split performance for anomalies',
  'ai-visibility': 'Crawled ranking pages for AI-readiness signals',
  'content-gap': 'Scored ranking pages for content completeness gaps',
  'competitor-intelligence': 'Checked real competitor rankings on tracked queries',
  'technical-seo': 'Checked index status, Core Web Vitals, and technical page health',
  authority: 'Computed real backlink-based Authority Score',
  'ai-recommendation': 'Checked real ChatGPT prompts for AI recommendation visibility',
  'security-headers': 'Checked real HTTP security headers across ranking pages',
  'internal-linking': 'Analyzed real internal link structure for link-equity dead ends',
  'duplicate-content': 'Hashed real page content to find byte-identical duplicates',
  accessibility: 'Checked real form labels, heading structure, and page-language attributes',
  'mobile-usability': 'Checked real viewport configuration for mobile rendering issues',
  'executive-report': 'Generated executive briefing across all specialist agents',
};

const shiftYmd = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Scans every REGISTERED agent (not just RECOMMENDATION_AGENT_IDS) so a new
// agent gets a correct category/name here the moment its file exists, even
// before anyone remembers to add its id to RECOMMENDATION_AGENT_IDS or
// OPPORTUNITY_AGENT_IDS — those two lists still separately gate which
// agents' findings actually populate Command Center's sections (a
// deliberate curatorial choice, not something to derive automatically), but
// display metadata (category/name, used by the activity feed and any
// already-shown finding) shouldn't silently mislabel an agent as 'seo' just
// because it hasn't been added to those lists yet.
let categoryByAgentIdCache = null;
export async function categoryByAgentId() {
  if (categoryByAgentIdCache) return categoryByAgentIdCache;
  const agents = await listAgentMeta();
  categoryByAgentIdCache = new Map(agents.map((meta) => [meta.id, { category: meta.category || 'seo', name: meta.name || meta.id }]));
  return categoryByAgentIdCache;
}

// Caps how many items from the same source contribute before the final
// slice, so one agent with many similar findings (e.g. the same missing-FAQ
// gap across a dozen pages) can't crowd out every other agent — a briefing
// should read as multi-agent and curated, not a dump from whichever agent
// happened to have the most findings this run. Same pattern already used in
// lib/insights.js's getPriorityRecommendations.
function capPerSource(items, sourceKey, perSourceCap, total) {
  const bySource = new Map();
  for (const item of items) {
    const key = item[sourceKey];
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(item);
  }
  return [...bySource.values()].flatMap((arr) => arr.slice(0, perSourceCap)).slice(0, total);
}

// `groundedById` = recommendations.items keyed by finding id (buildRecommendations'
// already-grounded params — e.g. a real query resolved for a meta-title/faq
// draft). A raw finding.recommendedAction can name a generatorId whose
// params were never grounded (buildRecommendations silently skips ones it
// couldn't ground, "never generate title/FAQ drafts without a real
// grounding query") — surfacing that ungrounded action here would let a
// user click a real "Fix" button straight into a 400. Every shaped finding
// that reaches the frontend with a live generatorId is guaranteed grounded.
function shapeFinding(f, meta, groundedById) {
  let recommendedAction = f.recommendedAction;
  if (recommendedAction?.generatorId) {
    const grounded = groundedById.get(f.id);
    // Ungrounded → strip generatorId/params (not the whole object) so the
    // frontend's `action?.generatorId` check still correctly hides the
    // "Fix" button, but `label` survives — losing it meant a perfectly
    // real, human-written headline (e.g. "Fix heading structure: exactly
    // one H1...") silently fell back to a generic "<Category> issue" title.
    recommendedAction = grounded
      ? { ...recommendedAction, params: grounded.params }
      : { ...recommendedAction, generatorId: null, params: null };
  }
  return {
    id: f.id, agentId: f.agentId, agentName: meta?.name, category: meta?.category || 'seo',
    priority: f.priority, evidence: f.evidence, whyItMatters: f.whyItMatters,
    // Only content-gap's AI-suggested entities carry a real confidence tier
    // today (low/medium/high, set by the LLM that inferred them) — every
    // other finding is deterministic (computed from real fetched data, not
    // inferred), so there's nothing honest to label as a confidence score.
    confidence: f.evidence?.confidence ?? null,
    recommendedAction, expectedImpact: f.expectedImpact,
  };
}

// Shared by getCommandCenterData's activity feed and the orchestration
// diagram's live activity rail (routes/agents.js GET /agents/activity) — one
// place that turns a raw agent_runs row into a human label + category.
function shapeActivity(rows, catByAgent) {
  return rows.map((r) => ({
    agentId: r.agent_id, status: r.status, tookMs: r.took_ms, createdAt: r.created_at,
    category: catByAgent.get(r.agent_id)?.category || 'seo',
    label: ACTIVITY_LABEL[r.agent_id] || `Ran ${catByAgent.get(r.agent_id)?.name || r.agent_id}`,
  }));
}

// Real recent runs across every registered agent, newest first — powers the
// orchestration diagram's "Live Activity" rail. Same shape/source
// (getRecentActivity + shapeActivity) as Command Center's AI Activity feed,
// just over every agent id instead of the recommendation-focused subset.
export async function getAgentActivityFeed(siteId, agentIds, limit = 12) {
  const [rows, catByAgent] = await Promise.all([
    getRecentActivity(siteId, agentIds, limit),
    categoryByAgentId(),
  ]);
  return shapeActivity(rows, catByAgent);
}

// Everything the AI Command Center's primary view needs, in one call. Reads
// only already-persisted data (like Reports/Action Center's cached path) —
// never triggers a live agent run; use the /command-center/refresh route for
// that, same split as Action Center's recommendations vs recommendations/refresh.
export async function getCommandCenterData(siteId) {
  const [findingRuns, execAndCompetitorRuns, activityRows, recommendations, catByAgent, watchlistRows, competitorRows, authorityHistory, mentionRateHistory, implementedFindingIds] = await Promise.all([
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    getLatestAgentRuns(siteId, ['executive-report', 'competitor-intelligence', 'authority', 'ai-recommendation', 'country-intelligence']),
    getRecentActivity(siteId, [...RECOMMENDATION_AGENT_IDS, 'executive-report'], 12),
    buildRecommendations(siteId),
    categoryByAgentId(),
    listWatchlist(siteId),
    listCompetitorProfiles(siteId),
    getAuthoritySnapshotHistory(siteId, 12),
    getMentionRateHistory(siteId, 12),
    getImplementedFindingIds(siteId),
  ]);
  const execRuns = execAndCompetitorRuns.filter((r) => r.agent_id === 'executive-report');
  const competitorRun = execAndCompetitorRuns.find((r) => r.agent_id === 'competitor-intelligence') || null;
  const authorityRun = execAndCompetitorRuns.find((r) => r.agent_id === 'authority') || null;
  const aiRecommendationRun = execAndCompetitorRuns.find((r) => r.agent_id === 'ai-recommendation') || null;
  const countryIntelligenceRun = execAndCompetitorRuns.find((r) => r.agent_id === 'country-intelligence') || null;

  const allFindings = findingRuns.flatMap((r) => r.findings.map((f) => ({ ...f, agentId: r.agentId })));
  const sortedFindings = [...allFindings].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const groundedById = new Map(recommendations.items.map((item) => [item.id, item]));

  const { score, penalty, findingsConsidered } = computeHealthScore(allFindings, implementedFindingIds, catByAgent);
  const today = new Date().toISOString().slice(0, 10);
  await saveHealthScoreSnapshot(siteId, today, score)
    .catch((e) => console.error('[command-center] failed to save health score snapshot:', e.message));
  const [weekAgoScore, monthAgoScore] = await Promise.all([
    getHealthScoreOnOrBefore(siteId, shiftYmd(today, -7)),
    getHealthScoreOnOrBefore(siteId, shiftYmd(today, -30)),
  ]);

  const execRun = execRuns[0] || null;
  const analysisStatus = !execRun ? 'never-run' : execRun.status === 'ok' ? 'complete' : execRun.status === 'insufficient-data' ? 'partial' : 'error';

  const generatedAt = new Date().toISOString();
  const trendWeek = weekAgoScore != null ? score - weekAgoScore : null;
  const findingChanges = await getFindingsDiff(siteId, RECOMMENDATION_AGENT_IDS, 10);
  const healthEntry = healthChangeEntry(trendWeek, generatedAt);
  const recentChanges = (healthEntry ? [healthEntry, ...findingChanges] : findingChanges).slice(0, 10);

  // Waterfall dedup: Critical Issues is the page's headline, so each section
  // below only shows findings that haven't already been surfaced above it —
  // otherwise the same finding (e.g. one AI-visibility gap) could appear as
  // a Critical Issue, a Discovery, a Growth Opportunity, AND a Recommended
  // Action all on one page, which reads as duplicated content, not curation.
  const criticalIssuesRaw = capPerSource(sortedFindings.filter((f) => f.priority === 'high'), 'agentId', 1, 3);
  const shownIds = new Set(criticalIssuesRaw.map((f) => f.id));

  const discoveriesRaw = capPerSource(sortedFindings.filter((f) => !shownIds.has(f.id)), 'agentId', 2, 8);
  discoveriesRaw.forEach((f) => shownIds.add(f.id));

  const growthOpportunitiesRaw = capPerSource(
    sortedFindings.filter((f) => OPPORTUNITY_AGENT_IDS.includes(f.agentId) && !shownIds.has(f.id)),
    'agentId', 3, 6
  );
  growthOpportunitiesRaw.forEach((f) => shownIds.add(f.id));

  const recommendedActionsRaw = capPerSource(recommendations.items.filter((item) => !shownIds.has(item.id)), 'source', 2, 6);

  // Open items only (new/in_progress) — the persistent queue itself. Closed
  // items (completed/no_longer_applicable) are real history, not part of
  // "what's still worth tracking," so they're left for a future history
  // view rather than cluttering the primary section.
  const watchlist = watchlistRows
    .filter((r) => OPEN_WATCHLIST_STATUSES.has(r.status))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    .map((r) => ({
      id: r.id, opportunityType: r.opportunity_type, findingId: r.finding_id, agentId: r.agent_id,
      agentName: catByAgent.get(r.agent_id)?.name, category: catByAgent.get(r.agent_id)?.category || 'seo',
      title: r.title, reason: r.reason, priority: r.priority, expectedImpact: r.expected_impact,
      confidence: r.confidence, evidence: r.evidence, recommendedAction: r.recommended_action,
      status: r.status, discoveredAt: r.discovered_at, statusChangedAt: r.status_changed_at,
      // Set only when the most recent transition was a sync-driven reopen
      // (see materialChangeDetected in store/watchlist.js) — lets the UI
      // show "reopened — {reason}" instead of looking like a brand-new item.
      reopened: r.last_transition_status === 'new' && r.last_transition_from && r.last_transition_from !== 'new'
        ? { reason: r.last_transition_reason, at: r.last_transition_at }
        : null,
    }));

  return {
    generatedAt,
    health: {
      score, penalty, findingsConsidered, trendWeek,
      trendMonth: monthAgoScore != null ? score - monthAgoScore : null,
    },
    executiveSummary: { narrative: execRun?.narrative || null, generatedAt: execRun?.created_at || null },
    stats: {
      // Both tiles below count the real, un-curated total using the SAME
      // filter as their matching section (priority === 'high' for Critical
      // Issues, OPPORTUNITY_AGENT_IDS for Growth Opportunities) — this used
      // to use a broader, mismatched filter (any finding with a
      // recommendedAction across all 7 agents) that had no relation to what
      // the Growth Opportunities section even shows. The section below is
      // deliberately curated/capped for display ("N shown", same pattern as
      // Critical Issues) — a tile number larger than the section's "shown"
      // count is expected once a site has more real findings than fit on
      // screen, not a bug.
      criticalIssues: allFindings.filter((f) => f.priority === 'high').length,
      newOpportunities: allFindings.filter((f) => OPPORTUNITY_AGENT_IDS.includes(f.agentId)).length,
      analysisStatus,
      lastAnalyzedAt: execRun?.created_at || null,
    },
    // Curated top-of-briefing callout — a small, distinct-agent subset of the
    // highest-priority findings. This is the page's headline; everything
    // below excludes whatever's already shown here.
    criticalIssues: criticalIssuesRaw.map((f) => shapeFinding(f, catByAgent.get(f.agentId), groundedById)),
    discoveries: discoveriesRaw.map((f) => shapeFinding(f, catByAgent.get(f.agentId), groundedById)),
    growthOpportunities: growthOpportunitiesRaw.map((f) => shapeFinding(f, catByAgent.get(f.agentId), groundedById)),
    recommendedActions: recommendedActionsRaw,
    watchlist,
    // AI-identified real competitors + structural comparison (see
    // agents/lib/competitor-analysis.js) — runs weekly, may be empty until
    // the first weekly executive report run has completed.
    competitors: competitorRows.map((r) => ({ id: r.id, domain: r.domain, lastAnalyzedAt: r.last_analyzed_at, comparison: r.comparison })),
    // Lets the UI tell "not analyzed yet" apart from "analyzed, found
    // nothing real" apart from "Google-ranking verification isn't
    // configured" — three honestly different reasons the list above can be
    // empty, previously collapsed into one generic message. dataForSeoConfigured
    // mirrors competitor-intelligence.js's own meta.dataSources check.
    competitorsMeta: {
      hasRun: !!competitorRun,
      status: competitorRun?.status ?? null,
      lastRunAt: competitorRun?.created_at ?? null,
      // Whether a real Google SERP provider (DataForSEO or the free Google
      // Custom Search provider) is configured — not specific to DataForSEO
      // anymore, see server/ingest/competitor-providers/index.js.
      dataForSeoConfigured: competitorProviderConfigured(),
    },
    // Real Google-SERP "who outranks you" comparison (server/agents/
    // competitor-intelligence.js's rankingComparison) — deliberately never a
    // 0-100 score, only real query/domain/position/impressions facts.
    // Distinct from competitors/competitorsMeta (structural/AI-readiness
    // score) above and from backlinkComparison (Common Crawl) below. Exposed
    // even when its own status is 'insufficient-data' — the frontend needs
    // serpProviderConfigured/checked/message to tell "not configured" apart
    // from "configured but never checked" apart from "checked, you lead".
    rankingComparison: competitorRun?.status === 'ok' ? (competitorRun.facts?.rankingComparison ?? null) : null,
    rankingComparisonMeta: {
      hasRun: !!competitorRun,
      lastRunAt: competitorRun?.created_at ?? null,
    },
    // Free Common Crawl referring-domain comparison vs. tracked competitors
    // (server/agents/lib/competitor-backlinks.js, Phase 6) — a distinct,
    // no-credential-needed signal from the structural comparison above and
    // from the paid DataForSEO-backed Authority Score below. Same
    // null-when-not-'ok' discipline as authority/aiRecommendation: never a
    // fabricated comparison when the site's own domain or every competitor
    // is absent from the Common Crawl dataset.
    backlinkComparison: competitorRun?.status === 'ok' && competitorRun.facts?.backlinkComparison?.status === 'ok'
      ? competitorRun.facts.backlinkComparison
      : null,
    backlinkComparisonMeta: {
      hasRun: !!competitorRun,
      status: competitorRun?.facts?.backlinkComparison?.status ?? null,
      message: competitorRun?.facts?.backlinkComparison?.message ?? null,
      lastRunAt: competitorRun?.created_at ?? null,
    },
    // Real backlink-based Authority Score (server/agents/authority.js) —
    // runs monthly, same empty-state discipline as competitorsMeta above:
    // "not configured" (no DataForSEO backlink credentials) is a distinct,
    // honest state from "not yet run" or "ran, no usable data."
    authority: authorityRun?.status === 'ok' ? {
      score: authorityRun.facts.authorityScore, priorScore: authorityRun.facts.priorScore,
      scoreDelta: authorityRun.facts.scoreDelta, breakdown: authorityRun.facts.scoreBreakdown,
      topLinkedPages: authorityRun.facts.topLinkedPages,
      dataSource: authorityRun.facts.dataSource,
      history: authorityHistory.map((r) => ({ date: r.snapshot_date, score: r.authority_score })),
    } : null,
    authorityMeta: {
      hasRun: !!authorityRun,
      status: authorityRun?.status ?? null,
      lastRunAt: authorityRun?.created_at ?? null,
      dataForSeoBacklinksConfigured: !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
    },
    // Real AI Recommendation tracking (server/agents/ai-recommendation.js —
    // distinct from ai-visibility, which only measures structural
    // readiness) — runs monthly, same empty-state discipline.
    aiRecommendation: aiRecommendationRun?.status === 'ok' ? {
      visibilityPct: aiRecommendationRun.facts.aiVisibilityPct,
      mentionedCount: aiRecommendationRun.facts.mentionedCount,
      promptsChecked: aiRecommendationRun.facts.promptsChecked,
      providers: aiRecommendationRun.facts.providers,
      providerCount: aiRecommendationRun.facts.providerCount,
      topPrompts: aiRecommendationRun.facts.topPrompts,
      missedPrompts: aiRecommendationRun.facts.missedPrompts,
      competitorsAppearingInstead: aiRecommendationRun.facts.competitorsAppearingInstead,
      shareOfAiVoicePct: aiRecommendationRun.facts.shareOfAiVoicePct,
      competitorCitationGapPct: aiRecommendationRun.facts.competitorCitationGapPct,
      history: mentionRateHistory.map((r) => ({
        date: r.run_date,
        pct: r.total_count > 0 ? Math.round((r.mentioned_count / r.total_count) * 100) : null,
      })),
    } : null,
    aiRecommendationMeta: {
      hasRun: !!aiRecommendationRun,
      status: aiRecommendationRun?.status ?? null,
      lastRunAt: aiRecommendationRun?.created_at ?? null,
      // One entry per known provider (lib/model-providers/index.js's
      // PROVIDERS) — each independently gated (its own key + dedicated
      // enable flag, see that provider's own configured()); replaces the
      // old single openAiConfigured boolean now that more than one provider
      // can be configured at once.
      providers: PROVIDERS.map((p) => ({ id: p.id, configured: p.configured() })),
    },
    geoIntelligence: countryIntelligenceRun?.status === 'ok' ? {
      topCountries: countryIntelligenceRun.facts.topCountries,
      growingMarkets: countryIntelligenceRun.facts.growingMarkets,
      decliningMarkets: countryIntelligenceRun.facts.decliningMarkets,
      topLanguages: countryIntelligenceRun.facts.topLanguages,
      lowCtrCountries: countryIntelligenceRun.facts.lowCtrCountries,
    } : null,
    geoIntelligenceMeta: {
      hasRun: !!countryIntelligenceRun,
      status: countryIntelligenceRun?.status ?? null,
      lastRunAt: countryIntelligenceRun?.created_at ?? null,
    },
    activity: shapeActivity(activityRows, catByAgent),
    recentChanges,
  };
}
