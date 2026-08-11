import React, { useState } from 'react';
import { Sparkles, TrendingUp, TrendingDown, Minus, Layers, Activity, Database } from 'lucide-react';
import { formatByUnit, pct } from '../lib/analystFormat.js';

const RING_COLORS = ['#3b82f6', '#ec4899', '#06b6d4', '#8b5cf6'];

function TrendBadge({ pctChange }) {
  if (pctChange == null) return <span className="text-slate-400 font-bold">—</span>;
  const direction = pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : 'flat';
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  const color = direction === 'up' ? 'text-emerald-600' : direction === 'down' ? 'text-rose-600' : 'text-slate-400';
  return (
    <span className={`inline-flex items-center gap-1 font-black ${color}`}>
      <Icon size={11} />{pct(pctChange)}
    </span>
  );
}

// Was a decorative card of hardcoded traffic-source percentages, a hardcoded
// "+81 Predicted"/"+24% Projected" badge, a hand-drawn SVG wave unrelated to
// any real series, and a bottom table of fabricated "Session ID"/"CPU Skew"/
// "System Heartbeat" rows that have no analog anywhere in this product.
// Replaced with the same real per-metric forecast/period_stats data
// AnalystDiagnosticHero already reads off the `dashboard` prop — same card
// layout (header, 2-card grid, bottom table), no redesign, but every number
// shown is now either observed, derived, or a real model forecast, with an
// honest "insufficient data" fallback where a metric has no forecast yet.
// Real metric_key prefixes (gsc_/ga4_ — see data-analyst-agent's collectors)
// used to filter the tab bar below, not a fabricated grouping.
const TABS = [
  { id: 'Overview', filter: () => true },
  { id: 'Traffic Sources', filter: (m) => m.metric_key.startsWith('ga4_') },
  { id: 'Query Telemetry', filter: (m) => m.metric_key.startsWith('gsc_') },
];

export default function AnalystPredictiveStudio({ dashboard }) {
  const [activeTab, setActiveTab] = useState('Overview');

  const allMetricsUnfiltered = Object.values(dashboard?.groups || {}).flat();
  const activeFilter = TABS.find((t) => t.id === activeTab)?.filter || TABS[0].filter;
  const allMetrics = allMetricsUnfiltered.filter(activeFilter);
  const topMetrics = allMetrics.slice(0, 4);
  const primary = allMetrics.find((m) => m.metric_key.includes('clicks') || m.metric_key.includes('sessions')) || allMetrics[0];

  const forecastedMetrics = topMetrics.filter((m) => m.forecast?.confidence != null);
  const avgConfidence = forecastedMetrics.length
    ? forecastedMetrics.reduce((sum, m) => sum + m.forecast.confidence, 0) / forecastedMetrics.length
    : null;

  const primaryForecast = primary?.forecast;
  const primaryPoints = primaryForecast?.status === 'ok' ? (primaryForecast.points || []) : [];
  const lastPoint = primaryPoints.length ? primaryPoints[primaryPoints.length - 1] : null;
  const horizonPctChange = lastPoint && primary?.latest_value
    ? ((lastPoint.point_estimate - primary.latest_value) / Math.abs(primary.latest_value)) * 100
    : null;

  // Simple real polyline from the metric's own forecast points — plotted on
  // its own min/max range, not against any other metric's scale.
  const wavePath = (() => {
    if (primaryPoints.length < 2) return null;
    const values = primaryPoints.map((p) => p.point_estimate);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = 500 / (primaryPoints.length - 1);
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * stepX},${100 - ((v - min) / span) * 90}`).join(' ');
  })();

  return (
    <div className="rounded-3xl bg-[#ffffff] border border-indigo-500/20 p-6 text-slate-900 shadow-2xl space-y-6">
      {/* Top Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-slate-900 shadow-lg">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-black uppercase tracking-wider text-slate-900">AI Predictive Intelligence Studio</h2>
              <span className="text-[9px] font-mono font-bold bg-indigo-100 text-indigo-500 border border-indigo-300 px-2 py-0.5 rounded-md">
                Forecasting Engine Active
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium mt-0.5">
              Real forecast data from the nightly model run — current value, forecast confidence, and week-over-week trend
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 bg-white p-1 rounded-2xl border border-slate-800">
          {TABS.map(({ id }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`text-xs font-bold px-3.5 py-1.5 rounded-xl transition ${
                activeTab === id
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-slate-900 shadow-xs'
                  : 'text-slate-400 hover:text-slate-900'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      {/* Top Grid: Metric Health Card + Predictive Forecast Wave Card */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Metric Health Overview */}
        <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-5 relative overflow-hidden flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-indigo-50 text-indigo-600 border border-violet-500/20 flex items-center justify-center">
                <Layers size={14} />
              </div>
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Metric Health Overview</h3>
            </div>
            <span className="text-[10px] font-mono font-bold text-slate-400 bg-white border border-slate-800 px-2 py-0.5 rounded-md">
              {avgConfidence != null ? `${Math.round(avgConfidence * 100)}% avg. confidence` : 'Insufficient data'}
            </span>
          </div>

          {topMetrics.length === 0 ? (
            <p className="text-[11px] font-medium text-slate-500 py-6 text-center">No metrics available yet.</p>
          ) : (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-6 py-2">
              {/* Legend List */}
              <div className="space-y-2.5 w-full sm:w-auto">
                {topMetrics.map((m, idx) => (
                  <div key={m.metric_key} className="flex items-center justify-between sm:justify-start gap-4 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: RING_COLORS[idx % RING_COLORS.length] }} />
                      <span className="text-slate-700 font-medium">{m.display_name || m.metric_key}</span>
                    </div>
                    <TrendBadge pctChange={m.period_stats?.wow?.pct_change} />
                  </div>
                ))}
              </div>

              {/* Avg confidence ring */}
              <div className="relative w-36 h-36 flex items-center justify-center shrink-0">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="48" stroke="#f1f5f9" strokeWidth="12" fill="none" />
                  {avgConfidence != null && (
                    <circle
                      cx="60" cy="60" r="48" stroke="#3b82f6" strokeWidth="12"
                      strokeDasharray={`${2 * Math.PI * 48 * avgConfidence} ${2 * Math.PI * 48 * (1 - avgConfidence)}`}
                      strokeDashoffset="0" fill="none" strokeLinecap="round"
                    />
                  )}
                </svg>
                <div className="absolute flex flex-col items-center justify-center text-center">
                  <span className="text-sm font-black text-slate-900">{avgConfidence != null ? `${Math.round(avgConfidence * 100)}%` : '—'}</span>
                  <span className="text-[9px] font-extrabold text-pink-400 uppercase tracking-wider">Confidence</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Card 2: Current Performance & Predictive Forecast Wave */}
        <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center">
                <TrendingUp size={14} />
              </div>
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                Predictive Performance Forecast{primary ? ` · ${primary.display_name || primary.metric_key}` : ''}
              </h3>
            </div>
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md border ${
              horizonPctChange != null
                ? (horizonPctChange >= 0 ? 'text-emerald-600 bg-emerald-950/60 border-emerald-800/60' : 'text-rose-600 bg-rose-950/40 border-rose-800/60')
                : 'text-slate-400 bg-white border-slate-800'
            }`}>
              {horizonPctChange != null ? `${pct(horizonPctChange)} projected` : 'Insufficient data'}
            </span>
          </div>

          {/* Real forecast polyline (or an honest empty state) */}
          <div className="h-40 w-full relative pt-2">
            {wavePath ? (
              <svg viewBox="0 0 500 110" className="w-full h-full overflow-visible" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line x1="0" y1="30" x2="500" y2="30" stroke="#f1f5f9" strokeDasharray="3 3" />
                <line x1="0" y1="70" x2="500" y2="70" stroke="#f1f5f9" strokeDasharray="3 3" />
                <path d={`${wavePath} L 500,110 L 0,110 Z`} fill="url(#waveFill)" />
                <path d={wavePath} fill="none" stroke="#a855f7" strokeWidth="3" strokeLinecap="round" />
                <g className="text-[9px] font-mono fill-slate-500">
                  {primaryPoints.map((p, i) => (
                    i % Math.ceil(primaryPoints.length / 6) === 0
                      ? <text key={p.forecast_date} x={(i * 500) / (primaryPoints.length - 1)} y="108">{p.forecast_date?.slice(5)}</text>
                      : null
                  ))}
                </g>
              </svg>
            ) : (
              <div className="h-full w-full flex items-center justify-center text-[11px] font-medium text-slate-500 text-center">
                Insufficient forecast history for this metric yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Table: real metric snapshot instead of fabricated telemetry rows */}
      <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Database size={14} className="text-indigo-600" />
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Metric Snapshot</h3>
          </div>
          <div className="flex items-center gap-2">
            <Activity size={11} className="text-slate-400" />
            <span className="text-[10px] font-mono text-slate-400">From the latest nightly forecast run</span>
          </div>
        </div>

        {allMetrics.length === 0 ? (
          <p className="text-[11px] font-medium text-slate-500 py-4 text-center">No metrics available yet.</p>
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-xs text-slate-700 border-collapse">
              <thead>
                <tr className="border-b border-slate-800/80 text-[10px] font-mono uppercase text-slate-500">
                  <th className="py-2 px-3">Metric</th>
                  <th className="py-2 px-3">Current</th>
                  <th className="py-2 px-3">WoW Trend</th>
                  <th className="py-2 px-3">Forecast</th>
                  <th className="py-2 px-3">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 font-mono text-[11px]">
                {allMetrics.map((m) => {
                  const points = m.forecast?.status === 'ok' ? m.forecast.points : null;
                  const last = points?.length ? points[points.length - 1] : null;
                  return (
                    <tr key={m.metric_key} className="hover:bg-slate-100 transition">
                      <td className="py-2.5 px-3 font-bold text-slate-900">{m.display_name || m.metric_key}</td>
                      <td className="py-2.5 px-3 text-slate-700">{formatByUnit(m.latest_value, m.unit)}</td>
                      <td className="py-2.5 px-3"><TrendBadge pctChange={m.period_stats?.wow?.pct_change} /></td>
                      <td className="py-2.5 px-3 text-slate-400">{last ? formatByUnit(last.point_estimate, m.unit) : 'Insufficient data'}</td>
                      <td className="py-2.5 px-3">
                        {m.forecast?.confidence != null ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full" style={{ width: `${Math.round(m.forecast.confidence * 100)}%` }} />
                            </div>
                            <span className="text-slate-700">{Math.round(m.forecast.confidence * 100)}%</span>
                          </div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
