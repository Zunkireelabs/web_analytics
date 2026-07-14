import { getSiteById, getDailySeries, getHealthScoreSeries } from '../../store/read.js';
import { getMostTrackedCompetitorDomain, getCompetitorStructuralTrend } from '../../store/competitor-profiles.js';
import { getAuthoritySnapshotHistory } from '../../store/authority.js';
import { getMentionRateHistory } from '../../store/ai-recommendation.js';

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
export async function buildGrowthReport(siteId) {
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

  const [performance, health, competitorSnapshots, authorityHistory, aiRecommendationHistory] = await Promise.all([
    getDailySeries(siteId, anchorDate, today),
    getHealthScoreSeries(siteId, anchorDate, today),
    trackedDomain ? getCompetitorStructuralTrend(siteId, trackedDomain.domain, anchorDate) : Promise.resolve([]),
    getAuthoritySnapshotHistory(siteId, AUTHORITY_HISTORY_LIMIT),
    getMentionRateHistory(siteId, AI_RECOMMENDATION_HISTORY_LIMIT),
  ]);

  return {
    available: true,
    site: site.name,
    onboardedAt: anchorDate,
    rangeStart: anchorDate,
    rangeEnd: today,
    performance: summarizePerformance(performance),
    healthScore: summarizeHealthScore(health),
    competitorTrend: summarizeCompetitorTrend(trackedDomain, competitorSnapshots),
    authorityTrend: summarizeAuthorityTrend(authorityHistory, anchorDate),
    aiRecommendationTrend: summarizeAiRecommendationTrend(aiRecommendationHistory, anchorDate),
  };
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
    position: firstLastDelta(rows, 'position'), // lower is better — caller/UI decides how to frame the sign
    ctr: firstLastDelta(rows, 'ctr'),
    series: rows.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
  };
}

// Honestly reflects however much real history has accumulated for whichever
// domain was actually tracked most — often just 1-2 points, since the same
// competitor domain doesn't reliably recur run to run. `null`/`available:
// false` when no domain has ever been snapshotted yet, not a fabricated line.
function summarizeCompetitorTrend(trackedDomain, rows) {
  if (!trackedDomain) return { available: false, domain: null, points: 0, first: null, latest: null, delta: null, series: [] };
  const first = rows[0]?.competitor_score ?? null;
  const latest = rows[rows.length - 1]?.competitor_score ?? null;
  return {
    available: true,
    domain: trackedDomain.domain,
    points: rows.length,
    first, latest,
    delta: rows.length >= 2 ? latest - first : null,
    series: rows.map((r) => ({ date: r.snapshot_at, score: r.competitor_score, ownScore: r.own_score })),
  };
}

// authority_snapshots is real, insert-only, monthly-cadence data (migration
// 035) — getAuthoritySnapshotHistory returns newest-first with no date-range
// param, so filtering to real >= anchorDate here and re-sorting chronological
// is cheaper than adding a second store function for a small, bounded list.
// Honestly requires DataForSEO backlink credentials configured — 0 real rows
// (not an error) until then, same as every other agent's insufficient-data
// path.
function summarizeAuthorityTrend(rows, anchorDate) {
  const anchor = new Date(anchorDate);
  const inRange = rows.filter((r) => new Date(r.snapshot_date) >= anchor)
    .sort((a, b) => new Date(a.snapshot_date) - new Date(b.snapshot_date));
  const first = inRange[0]?.authority_score ?? null;
  const latest = inRange[inRange.length - 1]?.authority_score ?? null;
  return {
    available: inRange.length > 0,
    points: inRange.length,
    first, latest,
    delta: inRange.length >= 2 ? latest - first : null,
    series: inRange.map((r) => ({ date: r.snapshot_date, score: r.authority_score })),
  };
}

// ai_prompt_runs mention-rate history (migration 036) — real per-run-date
// mentioned/total counts, turned into a % here. Requires OPENAI_API_KEY
// configured; honestly empty otherwise, same pattern as authority above.
function summarizeAiRecommendationTrend(rows, anchorDate) {
  const anchor = new Date(anchorDate);
  const inRange = rows.filter((r) => new Date(r.run_date) >= anchor)
    .map((r) => ({
      date: r.run_date,
      mentionRate: Number(r.total_count) > 0 ? Math.round((Number(r.mentioned_count) / Number(r.total_count)) * 100) : null,
    }))
    .filter((r) => r.mentionRate != null);
  const first = inRange[0]?.mentionRate ?? null;
  const latest = inRange[inRange.length - 1]?.mentionRate ?? null;
  return {
    available: inRange.length > 0,
    points: inRange.length,
    first, latest,
    delta: inRange.length >= 2 ? latest - first : null,
    series: inRange,
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
