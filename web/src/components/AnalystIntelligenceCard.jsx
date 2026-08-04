import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { api } from '../api.js';
import { formatByUnit, pct, SEVERITY_META } from '../lib/analystFormat.js';
import AnalystConfidenceBadge from './AnalystConfidenceBadge.jsx';

function TrendArrow({ direction, size = 12 }) {
  if (direction === 'up') return <TrendingUp size={size} className="text-emerald-600" />;
  if (direction === 'down') return <TrendingDown size={size} className="text-rose-600" />;
  return <Minus size={size} className="text-slate-400" />;
}

// Replaces the plain KpiTile grid — one compact "what does an AI analyst
// actually know about this metric" card instead of a bare number.
export default function AnalystIntelligenceCard({ clientId, metric, severity, onClick, selected }) {
  const [driver, setDriver] = useState(null); // null=loading | {} | {feature_metric_key, importance_pct}

  useEffect(() => {
    let cancelled = false;
    setDriver(null);
    api.analyst.featureImportance(clientId, metric.metric_key)
      .then((r) => {
        if (cancelled) return;
        setDriver(r.status === 'ok' && r.features?.length ? r.features[0] : {});
      })
      .catch(() => !cancelled && setDriver({}));
    return () => { cancelled = true; };
  }, [clientId, metric.metric_key]);

  const wow = metric.period_stats?.wow;
  const forecast = metric.forecast;
  const nextPoint = forecast?.status === 'ok' && forecast.points?.length ? forecast.points[0] : null;
  const lastPoint = forecast?.status === 'ok' && forecast.points?.length ? forecast.points[forecast.points.length - 1] : null;
  const horizonPctChange = lastPoint && metric.latest_value
    ? ((lastPoint.point_estimate - metric.latest_value) / Math.abs(metric.latest_value)) * 100
    : null;

  const trendDirection = wow?.pct_change > 0 ? 'up' : wow?.pct_change < 0 ? 'down' : horizonPctChange > 0 ? 'up' : horizonPctChange < 0 ? 'down' : 'flat';
  const sev = severity ? SEVERITY_META[severity] : null;

  return (
    <button
      type="button" onClick={onClick}
      className={`an-panel p-4 flex flex-col gap-2.5 text-left w-full transition cursor-pointer ${selected ? 'ring-2 ring-violet-500/40' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 truncate">{metric.display_name}</span>
        {sev && (
          <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md shrink-0"
            style={{ color: sev.color, backgroundColor: sev.bg }}>
            {sev.label}
          </span>
        )}
      </div>

      {/* Current value only — no WoW badge here, that's already covered by
          the Core Dashboard's KpiCard/StatCard. Kept as the baseline the
          Expected/Forecast fields below are measured against. */}
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-extrabold text-slate-900 tracking-tight">{formatByUnit(metric.latest_value, metric.unit)}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-2 border-t border-slate-200">
        <div>
          <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">Expected</div>
          <div className="text-[11px] font-bold text-slate-700">
            {nextPoint ? formatByUnit(nextPoint.point_estimate, metric.unit) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">Forecast</div>
          <div className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
            {horizonPctChange != null ? <>{pct(horizonPctChange)} <TrendArrow direction={horizonPctChange > 0 ? 'up' : 'down'} size={9} /></> : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">Primary Driver</div>
          <div className="text-[11px] font-bold text-slate-700 truncate" title={driver?.feature_metric_key}>
            {driver === null ? '…' : driver.feature_metric_key ? `${driver.feature_metric_key} (${Math.round(driver.importance_pct)}%)` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">Trend</div>
          <div className="text-[11px] font-bold text-slate-700 flex items-center gap-1 capitalize">
            <TrendArrow direction={trendDirection} size={10} /> {trendDirection}
          </div>
        </div>
      </div>

      {forecast?.status === 'ok' && (
        <AnalystConfidenceBadge status={forecast.confidence != null ? 'ok' : 'insufficient-data'} score={forecast.confidence} compact />
      )}
    </button>
  );
}
