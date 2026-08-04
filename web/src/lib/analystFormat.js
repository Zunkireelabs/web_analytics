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
