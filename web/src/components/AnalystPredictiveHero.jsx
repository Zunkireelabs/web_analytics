import { useMemo } from 'react';
import {
  Radar, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Sparkles, AlertTriangle, Crosshair,
} from 'lucide-react';
import { formatByUnit, pct } from '../lib/analystFormat.js';

// Prediction-first hero for the AI Data Analyst command center. Everything
// here is derived LIVE from the real dashboard payload's forecast +
// period_stats objects — never a fabricated projection. The headline
// narrative is computed in plain JS from actual predicted deltas, mirroring
// the product's "compute numbers first, hand the model prose only" rule.
function horizonPctChange(metric) {
  const f = metric?.forecast;
  const lastPoint = f?.status === 'ok' && f.points?.length ? f.points[f.points.length - 1] : null;
  if (!lastPoint || !metric?.latest_value) return null;
  return ((lastPoint.point_estimate - metric.latest_value) / Math.abs(metric.latest_value)) * 100;
}

function buildReadout(metrics) {
  const forecastable = metrics
    .filter((m) => m.forecast?.status === 'ok' && m.forecast.points?.length)
    .map((m) => ({ metric: m, delta: horizonPctChange(m) }))
    .filter((r) => r.delta != null);

  const up = forecastable.filter((r) => r.delta >= 0);
  const down = forecastable.filter((r) => r.delta < 0);
  const horizon = Math.max(0, ...forecastable.map((r) => r.metric.forecast.horizon_periods || 0));
  const biggestRisk = down.length ? down.sort((a, b) => a.delta - b.delta)[0] : null;
  const biggestGain = up.length ? up.sort((a, b) => b.delta - a.delta)[0] : null;
  return { forecastable, up, down, horizon, biggestRisk, biggestGain, total: metrics.length };
}

export default function AnalystPredictiveHero({ dashboard, onNavigateToSection }) {
  const metrics = useMemo(
    () => Object.entries(dashboard?.groups || {}).flatMap(([g, ms]) => ms.map((m) => ({ ...m, dashboard_group: g }))),
    [dashboard]
  );
  const readout = useMemo(() => buildReadout(metrics), [metrics]);

  if (metrics.length === 0) {
    return (
      <div className="an-panel-glow p-6 an-grid-bg">
        <div className="flex items-center gap-3">
          <Radar size={18} className="text-indigo-600" />
          <div>
            <div className="text-slate-700 font-black text-sm">Prediction Readout</div>
            <p className="text-xs text-slate-400">No metrics yet — ingest data to unlock forecasting.</p>
          </div>
        </div>
      </div>
    );
  }

  const upCount = readout.up.length;
  const downCount = readout.down.length;
  const neutralCount = readout.forecastable.length - upCount - downCount;
  const market = upCount > downCount ? 'up' : downCount > upCount ? 'down' : 'flat';

  const headline = readout.forecastable.length === 0
    ? 'Awaiting forecast runs — prediction models refresh nightly.'
    : market === 'up'
    ? `${upCount} of ${readout.forecastable.length} forecast metrics project growth over the next ${readout.horizon} periods.`
    : market === 'down'
    ? `${downCount} of ${readout.forecastable.length} forecast metrics project decline over the next ${readout.horizon} periods — prioritize the fixes below.`
    : `${readout.forecastable.length} forecast metrics project steady performance over the next ${readout.horizon} periods.`;

  return (
    <div className="an-panel-glow relative overflow-hidden an-grid-bg">
      {/* ambient glows */}
      <div className="absolute -top-24 -right-16 w-72 h-72 rounded-full opacity-25 blur-3xl pointer-events-none bg-violet-600" />
      <div className="absolute -bottom-24 -left-16 w-72 h-72 rounded-full opacity-20 blur-3xl pointer-events-none bg-cyan-500" />

      <div className="relative p-6 md:p-7">
        {/* Header row */}
        <div className="flex items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-slate-900 shadow-lg">
              <Radar size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2 -mt-1">
                <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Prediction Readout</h2>
                <span className="an-chip an-chip-violet">Forecasting Engine Live</span>
              </div>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">What the data says is coming next, before it arrives</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2">
            <span className={`an-chip ${market === 'up' ? 'an-chip-emerald' : market === 'down' ? 'an-chip-rose' : 'an-chip-slate'}`}>
              {market === 'up' ? <TrendingUp size={10} /> : market === 'down' ? <TrendingDown size={10} /> : null}
              {market === 'up' ? 'Uptrend ahead' : market === 'down' ? 'Downtrend ahead' : 'Steady ahead'}
            </span>
          </div>
        </div>

        {/* Headline narrative */}
        <p className="text-base md:text-lg font-bold text-slate-900 leading-snug max-w-3xl">
          {headline}
        </p>
        <p className="text-xs text-slate-400 font-medium mt-1">
          Projected from {readout.forecastable.length} live forecast models · confidence-weighted deltas from your own history.
        </p>

        {/* Projection key stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <Stat label="Metrics projected up" value={String(upCount)} tone="emerald" onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics'))} />
          <Stat label="Metrics projected down" value={String(downCount)} tone="rose" onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics'))} />
          <Stat label="Metrics steady" value={String(neutralCount)} tone="slate" onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics'))} />
          <Stat label="Forecast horizon" value={`${readout.horizon} periods`} tone="violet" onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics'))} />
        </div>

        {/* Featured risk / opportunity rail */}
        {readout.biggestRisk && (
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
            {readout.biggestRisk && (
              <FeaturedCard
                tone="rose"
                icon={AlertTriangle}
                title="Biggest predicted risk"
                metric={readout.biggestRisk.metric}
                delta={readout.biggestRisk.delta}
                onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics', readout.biggestRisk.metric.metric_key))}
              />
            )}
            {readout.biggestGain && (
              <FeaturedCard
                tone="emerald"
                icon={ArrowUpRight}
                title="Strongest growth signal"
                metric={readout.biggestGain.metric}
                delta={readout.biggestGain.delta}
                onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics', readout.biggestGain.metric.metric_key))}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`rounded-2xl bg-slate-100/50 border border-slate-200 p-3.5 text-left w-full ${onClick ? 'cursor-pointer hover:border-indigo-300 hover:bg-slate-100 transition' : ''}`}
    >
      <div className={`text-2xl font-black leading-none ${tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : tone === 'violet' ? 'text-indigo-500' : 'text-slate-700'}`}>
        {value}
      </div>
      <div className="an-label mt-1.5">{label}</div>
    </Tag>
  );
}

function FeaturedCard({ tone, icon: Icon, title, metric, delta, onClick }) {
  const positive = delta > 0;
  const forecast = metric.forecast;
  const lastPoint = forecast?.points?.[forecast.points.length - 1];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left w-full ${tone === 'rose' ? 'bg-rose-500/[0.06] border-rose-500/25' : 'bg-emerald-500/[0.06] border-emerald-500/25'} ${onClick ? 'cursor-pointer hover:brightness-95 transition' : ''}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} className={tone === 'rose' ? 'text-rose-600' : 'text-emerald-600'} />
        <span className="an-label">{title}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-black text-slate-900 truncate">{metric.display_name}</div>
          <div className="text-[10px] font-semibold text-slate-400 mt-0.5 flex items-center gap-1">
            <Crosshair size={9} />
            {metric.latest_value != null ? formatByUnit(metric.latest_value, metric.unit) : '—'}
            {' → '}
            {lastPoint ? formatByUnit(lastPoint.point_estimate, metric.unit) : '—'}
          </div>
        </div>
        <div className={`flex items-center gap-1 text-base font-black shrink-0 ${positive ? 'text-emerald-600' : 'text-rose-600'}`}>
          {positive ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
          {pct(delta)}
        </div>
      </div>
    </Tag>
  );
}