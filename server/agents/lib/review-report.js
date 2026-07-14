import { getSiteById, getHealthScoreSeries } from '../../store/read.js';
import { listWatchlist } from '../../store/watchlist.js';
import { getVerificationsForSite } from '../../store/fix-verifications.js';
import { getMostTrackedCompetitorDomain, getCompetitorStructuralTrend } from '../../store/competitor-profiles.js';
import { getAgentRunSummarySince } from '../../store/agent-runs.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { callLLM } from '../../llm.js';

// Staff-facing Review Report — a synthesized "what's happened on this
// engagement so far" summary, built entirely from real, already-computed
// data (no new metrics, no re-running agents). Mirrors the one real
// precedent for "bundle real facts, one callLLM narrative pass" —
// server/report/executive-doc.js's runExecutiveDocReport — rather than
// executive-report.js, which is a multi-agent orchestrator, not a single
// narrative pass.

const SECTION_KEYS = ['engagementSummary', 'healthTrend', 'watchlistProgress', 'fixVerification', 'recommendedNextSteps'];
const SECTION_LABELS = {
  engagementSummary: 'Engagement Summary',
  healthTrend: 'Health Score Trend',
  watchlistProgress: 'Watchlist Progress',
  fixVerification: 'Fix Verification',
  recommendedNextSteps: 'Recommended Next Steps',
};

function parseSections(raw) {
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const out = {};
    for (const key of SECTION_KEYS) {
      out[key] = typeof parsed[key] === 'string' && parsed[key].trim() ? parsed[key].trim() : 'Not enough data yet.';
    }
    return out;
  } catch {
    return SECTION_KEYS.reduce((acc, key, i) => {
      acc[key] = i === 0 ? (raw || 'Report generation failed.') : 'Not enough data yet.';
      return acc;
    }, {});
  }
}

function summarizeWatchlist(items) {
  const byStatus = { new: 0, in_progress: 0, completed: 0, no_longer_applicable: 0 };
  for (const item of items) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  return {
    total: items.length,
    open: byStatus.new + byStatus.in_progress,
    completed: byStatus.completed,
    noLongerApplicable: byStatus.no_longer_applicable,
    items: items.map((w) => ({ title: w.title, status: w.status, priority: w.priority, discoveredAt: w.discovered_at })),
  };
}

function summarizeVerifications(rows) {
  const byOutcome = { pending: 0, 'verified-fixed': 0, 'still-present': 0, unreachable: 0 };
  for (const row of rows) byOutcome[row.outcome] = (byOutcome[row.outcome] || 0) + 1;
  return { total: rows.length, ...byOutcome };
}

// Honestly reflects however much real history has accumulated for whichever
// domain was actually tracked most — often just 1-2 points, since the same
// competitor domain doesn't reliably recur run to run (see migration 034).
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

function summarizeHealthTrend(points) {
  if (!points.length) return { points: [], first: null, latest: null, delta: null };
  const first = points[0];
  const latest = points[points.length - 1];
  return {
    points: points.map((p) => ({ date: p.date, score: p.website_health_score })),
    first: { date: first.date, score: first.website_health_score },
    latest: { date: latest.date, score: latest.website_health_score },
    delta: points.length >= 2 ? latest.website_health_score - first.website_health_score : null,
  };
}

// Assembles the real data bundle for one site since its real onboarding
// anchor. `onboarded_at` is only ever set by the /internal/clients/:id/connect
// flow (server/routes/clients.js) — sites that predate it (or were connected
// via the older CLI scripts) have it NULL. Rather than show nothing, this
// falls back to the site's real created_at and marks that explicitly
// (`anchorIsFallback`), so the narrative can say so honestly instead of
// implying a real onboarding date that never happened.
export async function buildReviewReport(siteId) {
  const site = await getSiteById(siteId);
  if (!site) return null;

  const anchorIsFallback = !site.onboarded_at;
  const anchor = site.onboarded_at || site.created_at;
  const anchorDate = new Date(anchor).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Competitor identity isn't stable run to run (see migration 034's
  // comment) — pick whichever domain actually has the most real snapshot
  // history before fetching its trend, rather than an arbitrary domain.
  const trackedDomain = await getMostTrackedCompetitorDomain(siteId);

  const [healthSeries, watchlist, verifications, agentActivity, competitorSnapshots] = await Promise.all([
    getHealthScoreSeries(siteId, anchorDate, today),
    listWatchlist(siteId),
    getVerificationsForSite(siteId, anchor),
    getAgentRunSummarySince(siteId, RECOMMENDATION_AGENT_IDS, anchor),
    trackedDomain ? getCompetitorStructuralTrend(siteId, trackedDomain.domain, anchor) : Promise.resolve([]),
  ]);

  const facts = {
    site: site.name,
    anchorDate,
    anchorIsFallback,
    healthTrend: summarizeHealthTrend(healthSeries),
    watchlist: summarizeWatchlist(watchlist),
    verification: summarizeVerifications(verifications),
    agentActivity: agentActivity.map((r) => ({
      agentId: r.agent_id, totalRuns: r.total_runs, okRuns: r.ok_runs, errorRuns: r.error_runs, lastRunAt: r.last_run_at,
    })),
    // Data field only for now, not fed into the narrative prompt below —
    // competitor identity churn (see migration 034) means this is often
    // 1-2 points; surfaced honestly for the frontend to chart, not yet
    // worth a dedicated narrative section until real history accumulates.
    competitorTrend: summarizeCompetitorTrend(trackedDomain, competitorSnapshots),
  };

  const narrative = await generateNarrative(facts);
  return { facts, sections: narrative, generatedAt: new Date().toISOString() };
}

async function generateNarrative(facts) {
  const system = 'You are a growth strategist writing an INTERNAL, STAFF-FACING Review Report summarizing one ' +
    'client engagement so far — not a weekly digest, a look back over the whole relationship to date. You are ' +
    'given `facts`, real already-computed data: a health-score trend (may be very short — as few as 1-3 points — ' +
    'if the engagement is new; never force a narrative arc out of sparse data, say plainly that there is not ' +
    'much history yet), a Watchlist summary (open/completed/no-longer-applicable growth opportunities), a Fix ' +
    'Verification summary (real re-checks of implemented fixes: verified-fixed/still-present/unreachable/pending), ' +
    'and per-agent run activity counts. `anchorDate` is when this review\'s "since" window starts; if ' +
    '`anchorIsFallback` is true, this site has no real onboarding date on file and the anchor is just the site\'s ' +
    'creation date — say so plainly rather than implying a real onboarding happened on that date. Never invent a ' +
    'number not present in `facts`.\n\n' +
    'Return ONLY a JSON object (no prose, no markdown fences) with exactly these five string fields, each 2-4 ' +
    'plain-text sentences (no markdown, no bullet symbols):\n' +
    '- engagementSummary: what this engagement is and how much real history exists (cite anchorDate and whether ' +
    'it is a fallback)\n' +
    '- healthTrend: describe the real health-score trend from healthTrend — if fewer than 3 points exist, say so ' +
    'plainly instead of describing a trend that isn\'t really there\n' +
    '- watchlistProgress: real counts from watchlist — how many opportunities are open vs completed vs no longer ' +
    'applicable\n' +
    '- fixVerification: real counts from verification — how many implemented fixes were confirmed to actually ' +
    'stick (verified-fixed) vs still present vs unreachable vs still pending their check window; if total is 0, ' +
    'say plainly that no fixes have reached their verification window yet, never invent an outcome\n' +
    '- recommendedNextSteps: 2-3 concrete next steps grounded ONLY in the real gaps visible in facts (open high-' +
    'priority watchlist items, still-present verifications, agents with error_runs > 0) — never a generic ' +
    'platitude unconnected to the given data';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const raw = await callLLM(system, user, { maxTokens: 900 })
    .catch((err) => { console.warn('[review-report] narrative failed:', err.message); return null; });
  return parseSections(raw);
}

export { SECTION_LABELS };
