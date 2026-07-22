import { getSiteById, getDailySeries, getHealthScoreSeries } from '../../store/read.js';
import { getMostTrackedCompetitorDomain, getCompetitorStructuralTrend } from '../../store/competitor-profiles.js';
import { getAuthoritySnapshotHistory } from '../../store/authority.js';
import { getMentionRateHistory } from '../../store/ai-recommendation.js';
import { getActiveGrowthTargets } from '../../store/growth-targets.js';
import { configured as openaiConfigured } from './model-providers/openai.js';
import { getLatestFindings } from '../../store/agent-runs.js';
import { getImplementedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { projectHealthScore, projectClicks, projectImpressions, projectSnapshotTrend } from './growth-projection.js';
import { getLatestAuditRun, getAuditPageFindings } from '../../store/audit-runs.js';
import { growthPlanNarrativeEnabled, generateGrowthPlanNarrative } from './growth-plan.js';
import { saveGrowthPlanNarrative } from '../../store/upsert.js';

// Generous — clients see their own full findings list (not a truncated
// summary), and a full-site audit can genuinely produce more than the
// store's own 500-row default limit.
const AUDIT_FINDINGS_LIMIT = 2000;

// Generous limits, then filtered to the real anchor date below — both
// sources are monthly-or-slower cadence in production, so these comfortably
// cover any realistic growth-report window without needing a date-range
// variant of either store function.
const AUTHORITY_HISTORY_LIMIT = 24;
const AI_RECOMMENDATION_HISTORY_LIMIT = 24;

// Client-facing "how much have we actually grown you" view — real GSC
// clicks/impressions/position trend + real health-score trend, both reusing
// existing range-query functions as-is (no new metrics computed here).
//
// Strictly anchored to the site's real `onboarded_at` — unlike the internal
// Review Report (agents/lib/review-report.js), this NEVER falls back to
// `created_at`. Migration 030's own comment says onboarded_at must never be
// backfilled/guessed for a site that predates it; a client-facing growth
// claim is exactly the wrong place to paper over a missing real baseline
// with a stand-in date. A site with no real baseline yet gets an honest
// "not available" response instead of a chart anchored to a fabricated zero
// point.
// `includeGrowthPlan: false` skips the LLM growth-plan pass entirely — used
// by the growth-targets save routes below, which only need this report to
// resolve getMetricLatestValue() and have nothing to do with the growth
// plan narrative. Without this, saving any target incidentally re-ran (and
// sometimes re-triggered) a real LLM call that had nothing to do with what
// the client was doing.
export async function buildGrowthReport(siteId, { includeGrowthPlan = true } = {}) {
  const site = await getSiteById(siteId);
  if (!site) return null;

  if (!site.onboarded_at) {
    return {
      available: false,
      reason: 'no-baseline',
      message: 'Growth tracking starts once your onboarding baseline is set — check back after your first full analysis run.',
    };
  }

  const anchorDate = new Date(site.onboarded_at).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Competitor identity isn't stable run to run (see migration 034's
  // comment) — pick whichever domain actually has the most real snapshot
  // history before fetching its trend, rather than an arbitrary domain.
  const trackedDomain = await getMostTrackedCompetitorDomain(siteId);

  const [performance, health, competitorSnapshots, authorityHistory, aiRecommendationHistory, targets, findingRuns, implementedFindingIds, catByAgent, latestAuditRun] = await Promise.all([
    getDailySeries(siteId, anchorDate, today),
    getHealthScoreSeries(siteId, anchorDate, today),
    trackedDomain ? getCompetitorStructuralTrend(siteId, trackedDomain.domain, anchorDate) : Promise.resolve([]),
    getAuthoritySnapshotHistory(siteId, AUTHORITY_HISTORY_LIMIT),
    getMentionRateHistory(siteId, AI_RECOMMENDATION_HISTORY_LIMIT),
    getActiveGrowthTargets(siteId),
    getLatestFindings(siteId, RECOMMENDATION_AGENT_IDS),
    getImplementedFindingIds(siteId),
    categoryByAgentId(),
    getLatestAuditRun(siteId),
  ]);

  // Findings genuinely depend on which run came back above, so this can't
  // join the Promise.all — only fetched for a run that actually produced
  // rows (a 'running' audit with zero pages audited yet has none).
  const auditFindings = latestAuditRun && latestAuditRun.pages_audited > 0
    ? await getAuditPageFindings(latestAuditRun.id, { limit: AUDIT_FINDINGS_LIMIT })
    : [];

  const performanceSummary = summarizePerformance(performance);

  // Same flattening command-center.js's getCommandCenterData does — real
  // open findings across every recommendation agent, each tagged with the
  // agentId that produced it, feeding the AI-computed growth projections
  // below (server/agents/lib/growth-projection.js). Not the LLM: these
  // projections are pure math over this exact array.
  const allFindings = findingRuns.flatMap((r) => r.findings.map((f) => ({ ...f, agentId: r.agentId })));
  const baselineWeeklyClicks = performance.slice(-7).reduce((sum, r) => sum + (Number(r.clicks) || 0), 0);

  const clicksProjection = projectClicks(allFindings, implementedFindingIds, baselineWeeklyClicks);
  const impressionsProjection = projectImpressions(performance);
  const healthScoreProjection = projectHealthScore(allFindings, implementedFindingIds, catByAgent);
  const siteAudit = summarizeSiteAudit(latestAuditRun, auditFindings, catByAgent);

  const growthPlan = includeGrowthPlan
    ? await getOrGenerateGrowthPlan(site, latestAuditRun, {
        siteAuditFindingCounts: categoryCounts(siteAudit.findingsByCategory),
        healthScoreProjection, clicksProjection, performanceSummary,
      })
    : undefined;

  return {
    available: true,
    site: site.name,
    onboardedAt: anchorDate,
    rangeStart: anchorDate,
    rangeEnd: today,
    performance: {
      ...performanceSummary,
      targets: {
        impressions: toTarget(targets.impressions),
        ctr: toTarget(targets.ctr),
      },
      clicksProjection,
      impressionsProjection,
    },
    healthScore: {
      ...summarizeHealthScore(health),
      projection: healthScoreProjection,
    },
    siteAudit,
    growthPlan,
    competitorTrend: summarizeCompetitorTrend(trackedDomain, competitorSnapshots),
    authorityTrend: summarizeAuthorityTrend(authorityHistory, anchorDate),
    aiRecommendationTrend: summarizeAiRecommendationTrend(aiRecommendationHistory, anchorDate),
  };
}

// Real per-category finding counts (high/medium/low), not the full finding
// objects — all the growth-plan narrative prompt needs, and far cheaper to
// hand an LLM than the full findings-with-evidence payload siteAudit carries
// for the frontend.
function categoryCounts(findingsByCategory) {
  const out = {};
  for (const [category, findings] of Object.entries(findingsByCategory || {})) {
    out[category] = findings.reduce((acc, f) => { acc[f.priority] = (acc[f.priority] || 0) + 1; return acc; }, {});
  }
  return out;
}

// Cache-then-generate, same convention as the daily/weekly/monthly report
// narratives' sidecar staleness column: only calls the LLM when the latest
// COMPLETED audit run is different from whichever run the cached narrative
// was generated from — the common case (audit hasn't changed since last
// view) is a free read of the already-cached row.
//
// Deliberately does NOT blank the section out just because the *latest* run
// isn't completed yet — a still-running or failed re-audit has no real new
// findings to base a fresh narrative on, but a perfectly good cached
// narrative from the last completed run is still real and still true; it
// keeps being served (still correctly labeled with its own real
// generatedAt) until a NEW completed run actually produces something newer.
const growthPlanGenerationInFlight = new Set();
async function getOrGenerateGrowthPlan(site, latestAuditRun, facts) {
  if (!growthPlanNarrativeEnabled()) return { available: false, reason: 'not-configured' };

  const cached = site.growth_plan_narrative;
  const cachedGeneratedAt = site.growth_plan_narrative_generated_at;

  const canRegenerate = latestAuditRun?.status === 'completed'
    && site.growth_plan_narrative_audit_run_id !== latestAuditRun.id;

  if (!canRegenerate) {
    if (cached) return { available: true, ...cached, generatedAt: cachedGeneratedAt };
    return { available: false, reason: latestAuditRun ? 'no-completed-audit' : 'no-audit-yet' };
  }

  // Narrow in-process lock: two near-simultaneous requests during the same
  // staleness window (e.g. the page's own 5s poll firing right as a manual
  // reload happens, or two browser tabs open right as an audit completes)
  // would otherwise both call the LLM and both write. Serve whatever's
  // cached in the meantime rather than spending twice — the request right
  // after the in-flight one finishes picks up the fresh result.
  if (growthPlanGenerationInFlight.has(site.id)) {
    if (cached) return { available: true, ...cached, generatedAt: cachedGeneratedAt };
    return { available: false, reason: 'generating' };
  }

  growthPlanGenerationInFlight.add(site.id);
  try {
    const sections = await generateGrowthPlanNarrative(facts);
    await saveGrowthPlanNarrative(site.id, { sections, auditRunId: latestAuditRun.id });
    return { available: true, ...sections, generatedAt: new Date().toISOString() };
  } finally {
    growthPlanGenerationInFlight.delete(site.id);
  }
}

// growth_targets row -> the shape the frontend charts consume. null when no
// active target has been set for this metric (the common case pre-onboarding
// Step 3, or for a metric the client never set a goal for).
function toTarget(row) {
  if (!row) return null;
  return {
    value: Number(row.target_value),
    date: row.target_date,
    baselineValue: row.baseline_value != null ? Number(row.baseline_value) : null,
    baselineDate: row.baseline_date,
  };
}

// node-pg parses a DATE column into a JS Date at LOCAL midnight for that
// calendar date, but anchorDate (built via .toISOString().slice(0,10)
// elsewhere in this file) is a bare "YYYY-MM-DD" string, which the Date
// constructor parses as UTC midnight instead. Comparing those two Date
// representations directly is a real bug on any server not running in UTC —
// a local-midnight timestamp can fall on the "wrong side" of a UTC-midnight
// anchor, silently dropping today's real rows. Extracting LOCAL date parts
// (matching how node-pg built the Date) and comparing as plain strings
// sidesteps the mismatch entirely.
function dateOnlyStr(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// First/latest real values for a numeric field across a daily series — real
// gaps (no ingested data that day) are skipped rather than treated as zero,
// so a delta is only ever computed between two real observations.
function firstLastDelta(rows, key) {
  const withValue = rows.filter((r) => r[key] != null);
  if (!withValue.length) return { first: null, latest: null, delta: null };
  const first = Number(withValue[0][key]);
  const latest = Number(withValue[withValue.length - 1][key]);
  return { first, latest, delta: withValue.length >= 2 ? latest - first : null };
}

function summarizePerformance(rows) {
  return {
    daysInRange: rows.length,
    daysWithData: rows.filter((r) => r.clicks != null || r.impressions != null).length,
    clicksTotal: rows.reduce((sum, r) => sum + (Number(r.clicks) || 0), 0),
    impressionsTotal: rows.reduce((sum, r) => sum + (Number(r.impressions) || 0), 0),
    clicks: firstLastDelta(rows, 'clicks'),
    impressions: firstLastDelta(rows, 'impressions'),
    position: firstLastDelta(rows, 'position'), // lower is better — caller/UI decides how to frame the sign
    ctr: firstLastDelta(rows, 'ctr'),
    series: rows.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
  };
}

// Real "latest" value for a metric, from a report already built by
// buildGrowthReport — used to resolve a growth target's baseline_value
// server-side at set-time, so a client can never fabricate their own "here".
// Returns null if the metric has no real data yet rather than guessing.
// health_score, clicks, impressions, competitor_readiness, authority_score,
// and ai_recommendation_rate are all retired from manual targeting — see
// growth-projection.js for their AI-computed replacements. Only impressions
// and ctr (set per-tab from PerformanceTrendCard) remain manual.
export function getMetricLatestValue(report, metric) {
  switch (metric) {
    case 'impressions': return report.performance.impressions.latest;
    case 'ctr': return report.performance.ctr.latest;
    default: return null;
  }
}

export const GROWTH_TARGET_METRICS = ['impressions', 'ctr'];

// Honestly reflects however much real history has accumulated for whichever
// domain was actually tracked most — often just 1-2 points, since the same
// competitor domain doesn't reliably recur run to run. `null`/`available:
// false` when no domain has ever been snapshotted yet, not a fabricated line.
// Tracks `own_score` (this site's own structural readiness) for
// first/latest/delta/projection — NOT `competitor_score` (the tracked
// competitor's own score, kept in `series[].score` for comparison only) —
// "Competitor Readiness" means how ready THIS site is, not the competitor's.
function summarizeCompetitorTrend(trackedDomain, rows) {
  if (!trackedDomain) return { available: false, domain: null, points: 0, first: null, latest: null, delta: null, series: [], projection: projectSnapshotTrend([], { clampMax: 100 }) };
  const first = rows[0]?.own_score ?? null;
  const latest = rows[rows.length - 1]?.own_score ?? null;
  return {
    available: true,
    domain: trackedDomain.domain,
    points: rows.length,
    first, latest,
    delta: rows.length >= 2 ? latest - first : null,
    series: rows.map((r) => ({ date: r.snapshot_at, score: r.competitor_score, ownScore: r.own_score })),
    projection: projectSnapshotTrend(rows.map((r) => ({ date: r.snapshot_at, value: r.own_score })), { clampMax: 100 }),
  };
}

// authority_snapshots is real, insert-only, monthly-cadence data (migration
// 035) — getAuthoritySnapshotHistory returns newest-first with no date-range
// param, so filtering to real >= anchorDate here and re-sorting chronological
// is cheaper than adding a second store function for a small, bounded list.
// Honestly requires DataForSEO backlink credentials OR (migration 050) a
// Common Crawl fallback configured — 0 real rows (not an error) until then,
// same as every other agent's insufficient-data path. `dataSource` (from the
// latest real snapshot) tells the UI whether to badge this as a coarser
// Common-Crawl-only estimate — see server/agents/authority.js.
function summarizeAuthorityTrend(rows, anchorDate) {
  const inRange = rows.filter((r) => dateOnlyStr(r.snapshot_date) >= anchorDate)
    .sort((a, b) => new Date(a.snapshot_date) - new Date(b.snapshot_date));
  const first = inRange[0]?.authority_score ?? null;
  const latest = inRange[inRange.length - 1]?.authority_score ?? null;
  return {
    available: inRange.length > 0,
    points: inRange.length,
    first, latest,
    delta: inRange.length >= 2 ? latest - first : null,
    series: inRange.map((r) => ({ date: r.snapshot_date, score: r.authority_score })),
    dataSource: inRange[inRange.length - 1]?.data_source ?? null,
    projection: projectSnapshotTrend(inRange.map((r) => ({ date: r.snapshot_date, value: r.authority_score })), { clampMax: 100 }),
  };
}

// ai_prompt_runs mention-rate history (migration 036) — real per-run-date
// mentioned/total counts, turned into a % here. Requires OPENAI_API_KEY +
// AI_RECOMMENDATION_ENABLED=true configured; honestly empty otherwise, same
// pattern as authority above. `configured` is separate from `available`: it
// reflects whether the agent COULD run (env is set up), regardless of
// whether it ever actually has for this site — lets the UI distinguish "not
// connected at all" from "connected, just needs a first run".
function summarizeAiRecommendationTrend(rows, anchorDate) {
  const inRange = rows.filter((r) => dateOnlyStr(r.run_date) >= anchorDate)
    .map((r) => ({
      date: r.run_date,
      mentionRate: Number(r.total_count) > 0 ? Math.round((Number(r.mentioned_count) / Number(r.total_count)) * 100) : null,
    }))
    .filter((r) => r.mentionRate != null);
  const first = inRange[0]?.mentionRate ?? null;
  const latest = inRange[inRange.length - 1]?.mentionRate ?? null;
  return {
    available: inRange.length > 0,
    configured: openaiConfigured(),
    points: inRange.length,
    first, latest,
    delta: inRange.length >= 2 ? latest - first : null,
    series: inRange,
    projection: projectSnapshotTrend(inRange.map((r) => ({ date: r.date, value: r.mentionRate })), { clampMax: 100 }),
  };
}

// "Where You Stand Today" on Milestones — the client's own full findings
// from their most recent Full Site Audit (server/agents/lib/bulk-audit.js),
// grouped by category (same categoryByAgentId mapping Command Center's
// health score uses) so a real, concrete baseline can be shown before the
// AI-projected growth plan. Honest about non-happy-path states: `run: null`
// (no audit has ever run for this site yet), a still-`running` audit (real
// checkpointed pagesDiscovered/pagesAudited progress, findings so far), or a
// `failed` one (errorMessage) — never a fabricated/empty-looking "all clear."
function summarizeSiteAudit(run, findings, catByAgent) {
  if (!run) return { run: null, findingsByCategory: {} };

  const findingsByCategory = {};
  for (const f of findings) {
    const category = catByAgent.get(f.agent_id)?.category || 'seo';
    (findingsByCategory[category] ||= []).push({
      id: f.finding_id,
      agentId: f.agent_id,
      page: f.page,
      priority: f.priority,
      whyItMatters: f.why_it_matters,
      recommendedAction: f.recommended_action,
      expectedImpact: f.expected_impact,
    });
  }

  return {
    run: {
      id: run.id,
      status: run.status,
      triggeredBy: run.triggered_by,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      pagesDiscovered: run.pages_discovered,
      pagesAudited: run.pages_audited,
      healthScore: run.health_score,
      errorMessage: run.error_message,
    },
    findingsByCategory,
  };
}

function summarizeHealthScore(rows) {
  const withValue = rows.filter((r) => r.website_health_score != null);
  const first = withValue[0]?.website_health_score ?? null;
  const latest = withValue[withValue.length - 1]?.website_health_score ?? null;
  return {
    points: rows.length,
    first, latest,
    delta: withValue.length >= 2 ? latest - first : null,
    series: rows.map((r) => ({ date: r.date, score: r.website_health_score })),
  };
}
