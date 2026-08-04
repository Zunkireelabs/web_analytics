import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatByUnit, pct } from '../lib/analystFormat.js';

function TrendChip({ direction, value }) {
  if (value == null) return <span className="text-slate-400 text-[13px] font-bold">—</span>;
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  const color = direction === 'up' ? 'text-emerald-600' : direction === 'down' ? 'text-rose-600' : 'text-slate-400';
  return (
    <span className={`inline-flex items-center gap-1 text-[15px] font-extrabold ${color}`}>
      <Icon size={13} />{pct(value)}
    </span>
  );
}

// The hero header for the Diagnostic Tools workspace — one metric's
// headline numbers, all read straight off the same forecast/period_stats
// objects the rest of the section already fetches. Large figures on
// purpose: this is the one place on the page meant to be scanned from
// across the room, not the dense KPI-tile scale used elsewhere.
export default function AnalystDiagnosticHero({ metric, lastIngestedAt }) {
  const wow = metric.period_stats?.wow;
  const forecast = metric.forecast;
  const lastPoint = forecast?.status === 'ok' && forecast.points?.length ? forecast.points[forecast.points.length - 1] : null;
  const horizonPctChange = lastPoint && metric.latest_value
    ? ((lastPoint.point_estimate - metric.latest_value) / Math.abs(metric.latest_value)) * 100
    : null;
  const trendDirection = wow?.pct_change > 0 ? 'up' : wow?.pct_change < 0 ? 'down' : 'flat';

  return (
    <div className="an-panel p-7 relative overflow-hidden">
      <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full opacity-20 blur-3xl pointer-events-none bg-violet-600" />
      <div className="relative flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            {forecast?.status === 'ok' && (
              <span className="inline-flex items-center gap-1.5 text-[9.5px] font-extrabold text-indigo-500 bg-indigo-50 border border-indigo-200 rounded-full pl-1.5 pr-2.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                Model refreshed nightly
              </span>
            )}
          </div>
          <h2 className="text-[17px] font-extrabold text-slate-900 tracking-tight">{metric.display_name}</h2>
        </div>
        {lastIngestedAt && (
          <span className="text-[11px] font-semibold text-slate-500">
            Last ingested {new Date(lastIngestedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="relative flex items-end gap-8 flex-wrap">
        <div>
          <div className="text-[44px] leading-none font-extrabold text-slate-900 tracking-tight">
            {formatByUnit(metric.latest_value, metric.unit)}
          </div>
          <div className="text-[11px] font-bold text-slate-500 mt-2">Current value</div>
        </div>
        <div className="w-px self-stretch bg-slate-700/50" />
        <div>
          <div className="text-lg font-extrabold text-slate-800">
            {lastPoint ? formatByUnit(lastPoint.point_estimate, metric.unit) : '—'}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">
            Forecast{forecast?.horizon_periods ? ` · ${forecast.horizon_periods}d` : ''}
          </div>
        </div>
        <div>
          <div className="text-lg font-extrabold" style={{ color: forecast?.confidence != null ? '#8b5cf6' : '#94a3b8' }}>
            {forecast?.confidence != null ? `${Math.round(forecast.confidence * 100)}%` : '—'}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">Confidence</div>
        </div>
        <div>
          <TrendChip direction={trendDirection} value={wow?.pct_change} />
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">Trend, week over week</div>
        </div>
        <div>
          <div className="text-lg font-extrabold text-slate-800">{forecast?.status === 'ok' ? forecast.model : '—'}</div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">Model in use</div>
        </div>
        {horizonPctChange != null && (
          <div>
            <TrendChip direction={horizonPctChange > 0 ? 'up' : 'down'} value={horizonPctChange} />
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">Projected change</div>
          </div>
        )}
      </div>
    </div>
  );
}
