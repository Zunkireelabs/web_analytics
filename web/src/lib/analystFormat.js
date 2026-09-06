import { Clock, AlertTriangle, TrendingDown, Award } from 'lucide-react';

export const SEVERITY_META = {
  high: { label: 'High', color: '#e11d48', bg: '#e11d480c', border: '#e11d481e' },
  medium: { label: 'Medium', color: '#ea580c', bg: '#ea580c0c', border: '#ea580c1e' },
  low: { label: 'Low', color: '#64748b', bg: '#64748b0c', border: '#64748b1e' },
};

// Recolors/re-icons per insight_type already (forecast_risk vs anomaly vs
// trend_shift vs milestone) — the backend already tags this, so no backend
// change is needed for type-based treatment.
export const TYPE_META = {
  forecast_risk: { icon: Clock, label: 'Early Warning', color: '#8b5cf6' },
  anomaly: { icon: AlertTriangle, label: 'Anomaly', color: '#e11d48' },
  trend_shift: { icon: TrendingDown, label: 'Trend Shift', color: '#ea580c' },
  milestone: { icon: Award, label: 'Milestone', color: '#0ea5e9' },
};

export const METHOD_LABEL = { zscore: 'Z-score', iqr: 'IQR' };

// Shared by AnalystImpressionForecast and AnalystGrowthPulse — both need
// "where is this metric's forecast heading vs. its last real reading."
//
// A metric can have a perfectly good forecast while latest_value is null —
// latest_value is the most recent observation row, and the collectors write
// a NULL-valued row for a day the upstream API returned nothing. The
// forecast still renders in that case; only the percentage change, which
// genuinely needs a baseline to compare against, is withheld.
export function horizonChange(metric) {
  const f = metric?.forecast;
  const last = f?.status === 'ok' && f.points?.length ? f.points[f.points.length - 1] : null;
  if (!last) return null;
  const baseline = metric?.latest_value;
  const hasBaseline = typeof baseline === 'number' && baseline !== 0;
  return {
    endValue: last.point_estimate,
    baseline: hasBaseline ? baseline : null,
    deltaPct: hasBaseline ? ((last.point_estimate - baseline) / Math.abs(baseline)) * 100 : null,
    horizon: f.horizon_periods,
  };
}

// Average Position is stored with unit 'rank' (metrics_catalog seed,
// 0001_initial_schema.py:238), where a SMALLER number is a better ranking.
// Every "is this good or bad" question below therefore has to ask the metric,
// not just look at the sign — otherwise position improving from 20 to 12 reads
// as a decline, which is how "Average Position came in below its normal range"
// ended up in the issues list as a problem when it was the opposite.
export function isLowerBetter(metric) {
  return metric?.unit === 'rank';
}

// horizon_periods is a count of PERIODS, and a period means something
// different per metric cadence (forecast/run.py's HORIZON_BY_CADENCE: 14 for
// daily, 8 for weekly, 3 for monthly) — printing every metric's horizon as
// "Nd" was fine while every forecast happened to be daily-cadence, and became
// actively wrong once AI Recommendation Rate started forecasting on a weekly
// series (8 periods there means 8 WEEKS, not 8 days).
const CADENCE_UNIT = { daily: 'd', weekly: 'w', monthly: 'mo' };
export function horizonUnit(metric) {
  return CADENCE_UNIT[metric?.cadence] || 'd';
}

// Mirrors data-analyst-agent/app/config.py's min_history_*_for_forecast
// (30 days / 8 weeks / 3 months) — kept as a display-only mirror, not a
// second source of truth the backend reads: this only decides WORDING for
// the "not enough history yet" state, never whether a forecast exists.
// Cadence-specific on purpose — "AI Recommendation Rate is monthly, so it
// needs months of history" was true right up until it wasn't (see
// migration 0035): a metric can gain a real weekly pipeline mid-life, and the
// UI must say "insufficient WEEKLY forecast history", not a generic
// "insufficient data" that reads as if the pipeline itself is broken.
const MIN_HISTORY_LABEL = { daily: '30 days', weekly: '8 weeks', monthly: '3 months' };
export function insufficientHistoryLabel(metric) {
  const cadence = metric?.cadence || 'daily';
  const noun = cadence === 'weekly' ? 'weekly' : cadence === 'monthly' ? 'monthly' : 'daily';
  return `Insufficient ${noun} forecast history — needs about ${MIN_HISTORY_LABEL[cadence] || MIN_HISTORY_LABEL.daily}.`;
}

// Signed change re-expressed so NEGATIVE always means "worse for this site",
// whatever the metric's polarity. Everything downstream (severity, sorting,
// tone, the decline filter) reasons in this space instead of raw deltas.
export function adverseSignedPct(deltaPct, metric) {
  if (deltaPct == null) return null;
  return isLowerBetter(metric) ? -deltaPct : deltaPct;
}

// Every insight the agent found that represents something going in the WRONG
// direction for this metric — not just forecast risks. Mirrors isDecline() in
// server/agents/lib/analyst-seo-mapping.js so what's surfaced here is the
// same set the backend considers actionable.
//
// `metric` is optional only so existing callers that never handled rank
// metrics keep working; pass it whenever it's available, since without it a
// rank metric's polarity can't be known and the old (wrong) reading is used.
export function isDecline(i, metric) {
  const e = i.evidence || {};
  const lowerBetter = isLowerBetter(metric);
  switch (i.insight_type) {
    // The backend only emits forecast_risk for an adverse projection, and it
    // already applies the metric's polarity when deciding that, so this stays
    // unconditional.
    case 'forecast_risk': return true;
    case 'anomaly': return lowerBetter ? e.direction === 'high' : e.direction === 'low';
    case 'trend_shift': {
      if (typeof e.pct_change !== 'number') return false;
      return adverseSignedPct(e.pct_change, metric) < 0;
    }
    case 'milestone': return lowerBetter ? e.direction === 'up' : e.direction === 'down';
    default: return false;
  }
}

export function formatByUnit(value, unit) {
  if (value == null) return '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'seconds') return `${Math.round(value)}s`;
  if (unit === 'rank' || unit === 'score_0_100') return (Math.round(value * 10) / 10).toString();
  return Math.round(value).toLocaleString();
}

export function pct(v) {
  if (v == null) return '—';
  const rounded = Math.round(v * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

export function num(v) {
  if (v == null) return '—';
  return v !== 0 && Math.abs(v) < 1 ? v.toFixed(3) : Math.round(v).toLocaleString();
}

// Bolded, plain-English one-liner — the thing a non-technical reader needs
// first. The actual numbers move to supportingLine()/diagnosisText() below.
export function finding(insight, metric) {
  const e = insight.evidence || {};
  const label = metric.display_name;
  const strong = insight.severity === 'high';
  switch (insight.insight_type) {
    case 'anomaly':
      return e.direction === 'high'
        ? `${label} ${strong ? 'spiked well above' : 'came in above'} its normal range`
        : `${label} ${strong ? 'dropped well below' : 'came in below'} its normal range`;
    case 'trend_shift': {
      const up = e.pct_change > 0;
      const window = e.period_type === 'mom' ? 'this month' : 'this week';
      return `${label} ${up ? 'climbed' : 'declined'} sharply ${window}`;
    }
    case 'forecast_risk':
      return `${label} is on track to decline by ${e.predicted_date || 'the projected date'}`;
    case 'milestone':
      return `${label} just ${e.direction === 'up' ? 'crossed above' : 'fell below'} the ${e.crossed_band} mark`;
    default:
      return label;
  }
}

// The supporting stat line — actual zscore/iqr/pct values, plus a
// contextual breakdown (dimension_type/dimension_value) when present.
export function supportingLine(insight, metric) {
  const e = insight.evidence || {};
  const unit = metric.unit;
  const dimensionNote = insight.dimension_type && insight.dimension_type !== 'site' && insight.dimension_value
    ? ` · on ${insight.dimension_value}`
    : '';
  switch (insight.insight_type) {
    case 'anomaly': {
      const method = METHOD_LABEL[e.method] || e.method || 'stat';
      return `${method} score ${num(e.score)} · value ${formatByUnit(e.value, unit)}${dimensionNote}`;
    }
    case 'trend_shift':
      return `${pct(e.pct_change)} · ${formatByUnit(e.prior_value, unit)} → ${formatByUnit(e.current_value, unit)}${dimensionNote}`;
    case 'forecast_risk':
      return `${pct(e.pct_projected_change)} projected · model ${e.model || '—'}`;
    case 'milestone':
      return `${formatByUnit(e.prior_value, unit)} → ${formatByUnit(e.current_value, unit)}`;
    default:
      return null;
  }
}

// A fuller, prose "AI Diagnosis" sentence — distinct from finding()'s
// punchy headline, still derived only from the same real evidence fields.
export function diagnosisText(insight, metric) {
  const e = insight.evidence || {};
  const label = metric.display_name;
  const unit = metric.unit;
  switch (insight.insight_type) {
    case 'anomaly': {
      const dir = e.direction === 'high' ? 'increased' : 'decreased';
      const scoreNote = e.score != null ? ` (${METHOD_LABEL[e.method] || e.method || 'statistical'} score ${num(e.score)})` : '';
      return `${label} ${dir} to ${formatByUnit(e.value, unit)}, well outside its normal range${scoreNote}.`;
    }
    case 'trend_shift': {
      const dir = (e.pct_change ?? 0) > 0 ? 'increased' : 'decreased';
      const window = e.period_type === 'mom' ? 'compared with last month' : 'compared with last week';
      return `${label} ${dir} ${pct(e.pct_change)} ${window}, from ${formatByUnit(e.prior_value, unit)} to ${formatByUnit(e.current_value, unit)}.`;
    }
    case 'forecast_risk':
      return `${label} is projected to change ${pct(e.pct_projected_change)} by ${e.predicted_date || 'the projected date'} if the current trend continues.`;
    case 'milestone':
      return `${label} crossed the ${e.crossed_band ?? ''} mark, moving ${e.direction === 'up' ? 'upward' : 'downward'} from ${formatByUnit(e.prior_value, unit)} to ${formatByUnit(e.current_value, unit)}.`;
    default:
      return finding(insight, metric);
  }
}

// Supporting-evidence bullet list for Root Cause Analysis — same evidence
// fields as supportingLine()/statTiles(), phrased as standalone bullets
// rather than a compact tag line, plus dimension/correlation context when
// present.
export function evidenceBullets(insight, metric) {
  const e = insight.evidence || {};
  const unit = metric.unit;
  const bullets = [];

  switch (insight.insight_type) {
    case 'anomaly':
      bullets.push(`${METHOD_LABEL[e.method] || e.method || 'Statistical'} score of ${num(e.score)} exceeded the ${num(e.threshold_used)} threshold`);
      bullets.push(`Observed value: ${formatByUnit(e.value, unit)}`);
      break;
    case 'trend_shift':
      bullets.push(`Changed ${pct(e.pct_change)} ${e.period_type === 'mom' ? 'month-over-month' : 'week-over-week'}`);
      bullets.push(`${formatByUnit(e.prior_value, unit)} → ${formatByUnit(e.current_value, unit)}`);
      break;
    case 'forecast_risk':
      bullets.push(`Projected to change ${pct(e.pct_projected_change)} by ${e.predicted_date || 'the projected date'}`);
      bullets.push(`Forecast model: ${e.model || '—'} (${e.horizon_periods ?? '—'}-day horizon)`);
      break;
    case 'milestone':
      bullets.push(`Crossed the ${e.crossed_band ?? '—'} mark, moving ${e.direction || ''}`);
      bullets.push(`${formatByUnit(e.prior_value, unit)} → ${formatByUnit(e.current_value, unit)}`);
      break;
    default:
      break;
  }

  if (insight.dimension_type && insight.dimension_type !== 'site' && insight.dimension_value) {
    bullets.push(`Isolated to ${insight.dimension_type} “${insight.dimension_value}”`);
  }
  if (e.correlated_anomalies?.length) {
    for (const c of e.correlated_anomalies) {
      bullets.push(`${c.metric_key} also moved (${c.direction}) the same day`);
    }
  }
  return bullets;
}

// ── Forecast health ──────────────────────────────────────────────────────
//
// The same -10% the Python side uses to mint a forecast_risk insight
// (FORECAST_RISK_DECLINE_PCT, data-analyst-agent/app/config.py). Kept equal on
// purpose: "Projected decline" in the UI must mean exactly what the backend
// already decided was worth warning about, not a second, differently-drawn
// line.
export const FORECAST_RISK_PCT = 10;

export const HEALTH_META = {
  'at-risk': { label: 'Projected decline', color: '#e11d48', bg: '#e11d480f', border: '#e11d4826', chip: 'an-chip-rose' },
  watch: { label: 'Trending toward trouble', color: '#ea580c', bg: '#ea580c0f', border: '#ea580c26', chip: 'an-chip-amber' },
  healthy: { label: 'Healthy', color: '#059669', bg: '#0596690f', border: '#05966926', chip: 'an-chip-emerald' },
  'no-data': { label: 'Insufficient data', color: '#64748b', bg: '#64748b0c', border: '#64748b1e', chip: 'an-chip-slate' },
};

// The adverse edge of the forecast's own confidence band at the horizon — the
// lower bound normally, the UPPER bound for a rank metric, where a bigger
// number is the bad outcome. Returns null when the model didn't publish an
// interval, in which case the caller simply has no band evidence to reason
// with (and must not invent any).
function adverseBandEdge(metric) {
  const f = metric?.forecast;
  if (f?.status !== 'ok' || !f.points?.length) return null;
  const last = f.points[f.points.length - 1];
  const edge = isLowerBetter(metric) ? last.upper_bound : last.lower_bound;
  return typeof edge === 'number' ? edge : null;
}

// Which of the four states this metric is in, derived ONLY from forecast
// values the backend already produced plus the insights it already emitted.
// Nothing here extrapolates, re-fits, or invents a number.
//
//   at-risk  — the backend raised a forecast_risk for it, or the point
//              estimate itself crosses the same -10% line.
//   watch    — the point estimate is adverse but hasn't crossed that line,
//              AND there is corroborating evidence that it might: either the
//              confidence band's bad edge reaches the threshold, or the metric
//              is ALREADY deteriorating in observed data (an adverse anomaly
//              or trend shift). Requiring corroboration is what keeps "watch"
//              from swallowing every metric that happens to project -0.4%.
//   healthy  — a usable forecast that is flat or improving.
//   no-data  — no usable forecast. Stated plainly; never dressed up as calm.
export function forecastHealth(metric, insights = []) {
  const change = horizonChange(metric);
  if (!change) return { state: 'no-data', adversePct: null, daysUntilDrop: null };

  const mine = insights.filter((i) => i.metric_key === metric.metric_key);
  const riskInsight = mine.find((i) => i.insight_type === 'forecast_risk');
  const daysUntilDrop = riskInsight?.evidence?.days_until_drop ?? null;
  const adversePct = adverseSignedPct(change.deltaPct, metric);

  if (riskInsight || (adversePct != null && adversePct <= -FORECAST_RISK_PCT)) {
    return { state: 'at-risk', adversePct, daysUntilDrop, change };
  }

  if (adversePct != null && adversePct < 0) {
    const edge = adverseBandEdge(metric);
    const baseline = change.baseline;
    const bandCrosses =
      edge != null && typeof baseline === 'number' && baseline !== 0
        ? adverseSignedPct(((edge - baseline) / Math.abs(baseline)) * 100, metric) <= -FORECAST_RISK_PCT
        : false;
    // Excludes low-volume insights (a 1→0 page-level blip) — otherwise noise
    // that isLowConfidenceObservation exists specifically to demote could
    // still push the hero's health state to 'watch' on its own.
    const alreadySlipping = mine.some(
      (i) => i.insight_type !== 'forecast_risk' && isDecline(i, metric) && !isLowConfidenceObservation(i, metric)
    );
    if (bandCrosses || alreadySlipping) {
      return { state: 'watch', adversePct, daysUntilDrop, change, bandCrosses, alreadySlipping };
    }
  }

  return { state: 'healthy', adversePct, daysUntilDrop, change };
}

// ── Volume-aware significance ────────────────────────────────────────────
//
// A page going 1 click → 0 is a true -100%, and the statistics that produced
// it are not wrong — but it carries almost none of the site's actual traffic,
// so it must not out-shout a 10,000 → 8,500 move. These two floors decide
// which insights get demoted into "Low-confidence observations". Nothing is
// discarded; demotion is presentational only.
//
// The share floor is relative to the site's OWN current level for that metric
// rather than a fixed traffic number, so it scales with the site instead of
// encoding an assumption about how big a site should be.
export const LOW_VOLUME_SHARE = 0.01;
// Below this many events the percentage is arithmetically unstable no matter
// what the site's scale is (1 → 0 is -100%, 2 → 1 is -50%), so it also applies
// on its own when the site scale isn't known.
export const LOW_VOLUME_ABSOLUTE = 5;

// The largest raw value this insight is actually about, in the metric's own
// units. Returns null when the evidence carries no absolute value to judge
// (forecast_risk states percentages only).
export function insightMagnitude(insight) {
  const e = insight.evidence || {};
  switch (insight.insight_type) {
    case 'anomaly':
      return typeof e.value === 'number' ? Math.abs(e.value) : null;
    case 'trend_shift':
    case 'milestone': {
      const values = [e.prior_value, e.current_value].filter((v) => typeof v === 'number');
      return values.length ? Math.max(...values.map(Math.abs)) : null;
    }
    default:
      return null;
  }
}

// Whether this insight should be demoted as too small to act on.
//
// Deliberately narrow, because a false demotion hides a real problem:
//   - count metrics only. A ratio (CTR) or rank (position) is already
//     normalized, so "1% of the site's value" is not a meaningful test on it.
//   - site-level insights are never demoted — the site total IS the scale, so
//     comparing it to itself would be circular.
export function isLowConfidenceObservation(insight, metric) {
  if (metric?.unit !== 'count') return false;
  if (!insight.dimension_type || insight.dimension_type === 'site') return false;

  const magnitude = insightMagnitude(insight);
  if (magnitude == null) return false;
  if (magnitude < LOW_VOLUME_ABSOLUTE) return true;

  const siteScale = metric?.latest_value;
  if (typeof siteScale !== 'number' || siteScale <= 0) return false;
  return magnitude / siteScale < LOW_VOLUME_SHARE;
}

// Plain-English justification, shown wherever something has been demoted, so
// the rule is visible rather than the item just quietly vanishing.
export function lowConfidenceReason(insight, metric) {
  const magnitude = insightMagnitude(insight);
  if (magnitude == null) return 'Too little underlying volume to judge.';
  if (magnitude < LOW_VOLUME_ABSOLUTE) {
    return `Only ${formatByUnit(magnitude, metric?.unit)} at its peak — percentage swings this small are not reliable.`;
  }
  const share = metric?.latest_value ? (magnitude / metric.latest_value) * 100 : null;
  return share != null
    ? `Under ${share < 0.1 ? '0.1' : (Math.round(share * 10) / 10).toString()}% of the site's current ${metric.display_name.toLowerCase()}.`
    : 'A very small share of site-wide volume.';
}

// ── Grouping ─────────────────────────────────────────────────────────────
//
// One card per METRIC, not per insight. "Clicks declined sharply" and "Clicks
// forecast to decline" are the same story told at two points in time, and
// showing them as unrelated rows is what made the page feel like a pile of
// disconnected alerts. Splitting by tense is what lets the card read
// what happened → what's expected → why → what to fix.
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

export function groupDeclinesByMetric(insights = [], metrics = []) {
  const metricFor = (key) =>
    metrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key, unit: null };

  const byMetric = new Map();
  for (const insight of insights) {
    const metric = metricFor(insight.metric_key);
    if (!isDecline(insight, metric)) continue;
    if (!byMetric.has(insight.metric_key)) {
      byMetric.set(insight.metric_key, { metricKey: insight.metric_key, metric, happened: [], expected: [] });
    }
    const group = byMetric.get(insight.metric_key);
    (insight.insight_type === 'forecast_risk' ? group.expected : group.happened).push(insight);
  }

  const groups = [...byMetric.values()].map((group) => {
    const all = [...group.happened, ...group.expected];
    const severity = all
      .map((i) => i.severity)
      .sort((a, b) => (SEVERITY_RANK[a] ?? 3) - (SEVERITY_RANK[b] ?? 3))[0] || 'low';
    // A metric is only demoted when EVERY insight under it is low-volume —
    // one material problem keeps the whole card in the main list.
    const lowConfidence = all.length > 0 && all.every((i) => isLowConfidenceObservation(i, group.metric));
    // The narration the nightly pass attached to any insight in this group;
    // preferring the forecast one keeps "why" aligned with "what's expected".
    const narrated = [...group.expected, ...group.happened].find((i) => i.root_cause || i.recommendation) || null;
    return {
      ...group, all, severity, lowConfidence, narrated,
      health: forecastHealth(group.metric, insights),
    };
  });

  const stateRank = { 'at-risk': 0, watch: 1, healthy: 2, 'no-data': 3 };
  return groups.sort((a, b) => {
    if (a.lowConfidence !== b.lowConfidence) return a.lowConfidence ? 1 : -1;
    const sev = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (sev !== 0) return sev;
    return (stateRank[a.health.state] ?? 4) - (stateRank[b.health.state] ?? 4);
  });
}
