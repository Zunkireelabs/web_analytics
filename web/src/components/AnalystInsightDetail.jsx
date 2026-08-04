import { useEffect, useState } from 'react';
import { X, BarChart2 } from 'lucide-react';
import { api } from '../api.js';

function formatByUnit(value, unit) {
  if (value == null) return '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'seconds') return `${Math.round(value)}s`;
  if (unit === 'rank' || unit === 'score_0_100') return (Math.round(value * 10) / 10).toString();
  return Math.round(value).toLocaleString();
}

function pct(v) {
  if (v == null) return '—';
  const rounded = Math.round(v * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function num(v) {
  if (v == null) return '—';
  return v !== 0 && Math.abs(v) < 1 ? v.toFixed(3) : Math.round(v).toLocaleString();
}

// All three tiles per type come straight from fields the dashboard payload
// already returns (evidence + the metric card's own period_stats) — no new
// backend call, per the rework brief.
function statTiles(insight, metric) {
  const e = insight.evidence || {};
  const unit = metric.unit;
  switch (insight.insight_type) {
    case 'anomaly':
      return [
        { label: e.direction === 'high' ? 'Peak value' : 'Low value', value: formatByUnit(e.value, unit) },
        { label: 'Typical (last week)', value: formatByUnit(metric.period_stats?.wow?.prior_value ?? metric.period_stats?.mom?.prior_value, unit) },
        { label: e.method === 'zscore' ? 'Z-score' : e.method === 'iqr' ? 'IQR score' : 'Score', value: `${num(e.score)} (thr ${num(e.threshold_used)})` },
      ];
    case 'trend_shift':
      return [
        { label: 'Current', value: formatByUnit(e.current_value, unit) },
        { label: 'Prior period', value: formatByUnit(e.prior_value, unit) },
        { label: 'Change', value: pct(e.pct_change) },
      ];
    case 'forecast_risk': {
      const projected = e.last_actual != null && e.pct_projected_change != null
        ? e.last_actual * (1 + e.pct_projected_change / 100)
        : null;
      return [
        { label: 'Current', value: formatByUnit(e.last_actual, unit) },
        { label: `Projected by ${e.predicted_date || '—'}`, value: formatByUnit(projected, unit) },
        { label: 'Projected change', value: pct(e.pct_projected_change) },
      ];
    }
    case 'milestone':
      return [
        { label: 'Prior', value: formatByUnit(e.prior_value, unit) },
        { label: 'Current', value: formatByUnit(e.current_value, unit) },
        { label: 'Crossed', value: `${e.crossed_band ?? '—'}` },
      ];
    default:
      return [];
  }
}

export default function AnalystInsightDetail({ insight, metric, clientId, onClose }) {
  const [breakdown, setBreakdown] = useState(null);
  // Guarded: today's GET /dashboard/{client}/{...} insight objects never
  // set dimension_type/dimension_value (dashboard.py's get_dashboard()
  // omits them even though Insight/Anomaly rows carry them — anomaly
  // detection itself runs per dimension, see
  // data-analyst-agent/app/stats/anomalies.py). So this branch is
  // currently always false; wiring those two fields into the insights
  // list would activate it for free via the existing
  // /dashboard/{client}/breakdown/{metric_key}/{dimension_type} route,
  // already proxied as api.analyst.breakdown.
  const hasBreakdown = Boolean(insight.dimension_type && insight.dimension_type !== 'site' && insight.dimension_value);

  useEffect(() => {
    setBreakdown(null);
    if (!hasBreakdown) return;
    api.analyst.breakdown(clientId, insight.metric_key, insight.dimension_type)
      .then(setBreakdown)
      .catch(() => setBreakdown(null));
  }, [clientId, insight.metric_key, insight.dimension_type, hasBreakdown]);

  const tiles = statTiles(insight, metric);
  const rows = breakdown?.breakdown || [];
  const maxValue = Math.max(...rows.map((r) => r.latest_value || 0), 1);

  return (
    <div className="an-panel p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-indigo-600">Zoomed in</p>
          <h3 className="text-sm font-bold text-slate-900 mt-0.5 truncate">{metric.display_name} · {insight.period_start}</h3>
        </div>
        <button type="button" onClick={onClose}
          className="shrink-0 w-11 h-11 grid place-items-center rounded-2xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition focus:outline-none cursor-pointer"
          aria-label="Close detail view">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-1">
        {tiles.map((t) => (
          <div key={t.label} className="bg-slate-100/80 rounded-2xl border border-slate-200 p-3 min-w-0">
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-500 truncate">{t.label}</div>
            <div className="text-sm font-extrabold text-slate-900 mt-1 truncate">{t.value}</div>
          </div>
        ))}
      </div>

      {hasBreakdown && rows.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart2 size={12} className="text-indigo-600" />
            <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">By {insight.dimension_type}</span>
          </div>
          <div className="space-y-1.5">
            {rows.slice(0, 8).map((row) => (
              <div key={row.dimension_value} className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-slate-400 w-28 truncate shrink-0" title={row.dimension_value}>
                  {row.dimension_value}
                </span>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${row.dimension_value === insight.dimension_value ? 'bg-rose-500' : 'bg-indigo-400/60'}`}
                    style={{ width: `${Math.max(4, ((row.latest_value || 0) / maxValue) * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] font-bold text-slate-500 w-14 text-right shrink-0">{formatByUnit(row.latest_value, metric.unit)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
