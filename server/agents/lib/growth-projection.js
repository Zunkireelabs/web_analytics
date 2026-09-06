import { computeHealthScore, getOpenScoreableFindings, dedupeKey } from './health-score.js';

// AI-computed "today -> +1mo -> +2mo -> +3mo" trajectory, shown on the
// Milestones page (server/agents/lib/growth-report.js) alongside real
// historical data. Deliberately NOT an LLM call: every number here is a
// deterministic function of the site's own currently-open findings, run
// through the exact same computeHealthScore formula the live score already
// uses (just against a simulated future implementedFindingIds set) — same
// house convention as every other estimate in this codebase (see
// opportunity.js's estimatedTrafficGain): numbers are computed in plain JS,
// never invented or chosen by a model. Always labeled basis: 'estimate'.
const MONTHS_OUT = [0, 1, 2, 3];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function addMonths(monthsOut) {
  const d = new Date();
  d.setDate(d.getDate() + monthsOut * 30);
  return d.toISOString().slice(0, 10);
}

// Cumulative "resolved by month N" id sets — highest-priority findings
// assumed fixed first, split into 3 roughly-equal chunks by count. Month 0
// (today) always resolves nothing, so points[0].value matches the real
// current score/baseline exactly.
function cumulativeBuckets(rankedFindings) {
  const n = rankedFindings.length;
  const chunk = Math.ceil(n / 3);
  return MONTHS_OUT.map((monthsOut) => {
    const count = Math.min(n, monthsOut * chunk);
    return { monthsOut, resolved: rankedFindings.slice(0, count) };
  });
}

export function projectHealthScore(allFindings, implementedFindingIds, categoryByAgentIdMap) {
  const open = getOpenScoreableFindings(allFindings, implementedFindingIds);
  const ranked = [...open].sort((a, b) => {
    const byPriority = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    if (byPriority !== 0) return byPriority;
    return Math.abs(b.expectedImpact?.value ?? 0) - Math.abs(a.expectedImpact?.value ?? 0);
  });
  const highPriorityCount = ranked.filter((f) => f.priority === 'high').length;

  // Every RAW finding id sharing a dedup-representative's key, grouped up
  // front — "resolving" an issue below must clear the whole group, not just
  // the one representative id computeHealthScore's dedup happened to pick,
  // or a lower-severity duplicate from a different agent resurfaces as the
  // new dedup winner and the projection can never reach a clean 100 even
  // once every tracked issue is marked resolved.
  const rawIdsByKey = new Map();
  for (const f of allFindings) {
    const key = dedupeKey(f);
    if (!rawIdsByKey.has(key)) rawIdsByKey.set(key, []);
    rawIdsByKey.get(key).push(f.id);
  }

  const points = cumulativeBuckets(ranked).map(({ monthsOut, resolved }) => {
    const simulatedImplemented = new Set(implementedFindingIds);
    for (const f of resolved) {
      for (const id of rawIdsByKey.get(dedupeKey(f)) || [f.id]) simulatedImplemented.add(id);
    }
    return {
      monthsOut,
      date: addMonths(monthsOut),
      value: computeHealthScore(allFindings, simulatedImplemented, categoryByAgentIdMap).score,
    };
  });

  return {
    basis: 'estimate',
    openCount: ranked.length,
    highPriorityCount,
    points,
    assumptions: ranked.length
      ? `Projected from ${ranked.length} open recommendation${ranked.length === 1 ? '' : 's'} (${highPriorityCount} high-priority), assuming steady progress fixing the highest-priority ones first. Not a guarantee.`
      : 'No open recommendations right now — nothing left to project against.',
  };
}

export function projectClicks(allFindings, implementedFindingIds, baselineWeeklyClicks) {
  const opportunities = allFindings.filter((f) => f.agentId === 'opportunity' && !implementedFindingIds.has(f.id));
  const ranked = [...opportunities].sort((a, b) => (b.expectedImpact?.value ?? 0) - (a.expectedImpact?.value ?? 0));

  const points = cumulativeBuckets(ranked).map(({ monthsOut, resolved }) => ({
    monthsOut,
    date: addMonths(monthsOut),
    value: Math.round(baselineWeeklyClicks + resolved.reduce((sum, f) => sum + (f.expectedImpact?.value ?? 0), 0)),
  }));

  return {
    basis: 'estimate',
    openCount: ranked.length,
    unit: '/week',
    baselineWeeklyClicks: Math.round(baselineWeeklyClicks),
    points,
    assumptions: ranked.length
      ? `Projected from ${ranked.length} open keyword opportunit${ranked.length === 1 ? 'y' : 'ies'} your Opportunity agent flagged, assuming the highest-traffic ones get captured first, on top of your real trailing 7-day click count. Not a guarantee.`
      : 'No open keyword opportunities right now — nothing left to project against.',
  };
}

const WEEK_DAYS = 7;
// Two full trailing weeks of real data required before a week-over-week
// trend is trusted — unlike clicks (a real modeled gain from the Opportunity
// agent's CTR-by-position curve, an established industry baseline), there is
// no comparable industry-standard curve for "impressions gained by ranking
// higher" — impressions depend on total query-variation search volume, which
// has no equivalent standard elasticity. So this is grounded differently:
// continuing the site's OWN real observed trend forward, never an invented
// elasticity constant. A brand-new site (under 14 real days) honestly gets a
// flat baseline instead of a guessed trend.
const MIN_TREND_DAYS = WEEK_DAYS * 2;
const DAYS_PER_MONTH = 30;

export function projectImpressions(dailySeries) {
  const withData = dailySeries.filter((r) => r.impressions != null);
  const recentWeek = withData.slice(-WEEK_DAYS);
  const priorWeek = withData.slice(-WEEK_DAYS * 2, -WEEK_DAYS);
  const baselineWeeklyImpressions = recentWeek.reduce((sum, r) => sum + (Number(r.impressions) || 0), 0);

  const hasEnoughHistory = withData.length >= MIN_TREND_DAYS && priorWeek.length === WEEK_DAYS;
  const weeklyDelta = hasEnoughHistory
    ? baselineWeeklyImpressions - priorWeek.reduce((sum, r) => sum + (Number(r.impressions) || 0), 0)
    : 0;

  const points = MONTHS_OUT.map((monthsOut) => ({
    monthsOut,
    date: addMonths(monthsOut),
    value: Math.max(0, Math.round(baselineWeeklyImpressions + weeklyDelta * (monthsOut * DAYS_PER_MONTH / WEEK_DAYS))),
  }));

  return {
    basis: 'estimate',
    unit: '/week',
    baselineWeeklyImpressions: Math.round(baselineWeeklyImpressions),
    points,
    assumptions: hasEnoughHistory
      ? `Projected by continuing your real trailing week-over-week impressions trend (${weeklyDelta >= 0 ? '+' : ''}${Math.round(weeklyDelta)}/week) forward. Not a guarantee.`
      : `Not enough real history yet to project a trend (need ${MIN_TREND_DAYS}+ days of data) — showing your current baseline held flat until more history accumulates.`,
  };
}

// Generic real-snapshot-trend projection for irregular/monthly-cadence
// metrics (Competitor Readiness, Authority Score, AI Recommendation Rate) —
// unlike projectImpressions' calendar-week windows (daily GSC data),
// these accumulate real points at unpredictable intervals (a monthly agent
// run, an event-driven competitor check), so this compares the recent HALF
// of available real points against the prior half and derives a real
// per-day rate from the actual date gap between them, rather than assuming
// any fixed cadence. Requires >= MIN_SNAPSHOT_TREND_POINTS real points (two
// comparable halves) before trusting a trend — otherwise an honest flat
// baseline, same "never fabricate" convention as every other projection
// here. `clampMax` bounds the projected value (these are all 0-100 scores/
// rates, unlike clicks/impressions which have no ceiling).
const MIN_SNAPSHOT_TREND_POINTS = 4;

export function projectSnapshotTrend(points, { clampMax = null } = {}) {
  const clamp = (v) => Math.max(0, clampMax != null ? Math.min(clampMax, v) : v);

  if (!points.length) {
    return {
      basis: 'estimate',
      current: null,
      points: MONTHS_OUT.map((monthsOut) => ({ monthsOut, date: addMonths(monthsOut), value: null })),
      assumptions: 'No real snapshots yet — nothing to project from.',
    };
  }

  const current = points[points.length - 1].value;
  const half = Math.floor(points.length / 2);
  const hasEnoughHistory = points.length >= MIN_SNAPSHOT_TREND_POINTS && half >= 2;

  let dailyRate = 0;
  if (hasEnoughHistory) {
    const recentHalf = points.slice(-half);
    const priorHalf = points.slice(-half * 2, -half);
    const avg = (arr) => arr.reduce((sum, p) => sum + (Number(p.value) || 0), 0) / arr.length;
    const recentMidDate = new Date(recentHalf[Math.floor(recentHalf.length / 2)].date);
    const priorMidDate = new Date(priorHalf[Math.floor(priorHalf.length / 2)].date);
    const daysBetween = Math.max(1, (recentMidDate - priorMidDate) / 86400000);
    dailyRate = (avg(recentHalf) - avg(priorHalf)) / daysBetween;
  }

  const projectedPoints = MONTHS_OUT.map((monthsOut) => ({
    monthsOut,
    date: addMonths(monthsOut),
    value: Math.round(clamp(current + dailyRate * (monthsOut * DAYS_PER_MONTH))),
  }));

  return {
    basis: 'estimate',
    current,
    points: projectedPoints,
    assumptions: hasEnoughHistory
      ? `Projected by continuing the real trend across your last ${points.length} snapshots forward. Not a guarantee.`
      : `Not enough real snapshot history yet (need ${MIN_SNAPSHOT_TREND_POINTS}+) — showing your current value held flat until more accumulates.`,
  };
}
