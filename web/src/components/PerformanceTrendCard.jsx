import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ComposedChart, Area, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ArrowRight, Target } from 'lucide-react';
import GrowthTargetForm, { buildChartRows } from './GrowthTargetForm.jsx';

const METRICS = [
  { key: 'impressions', label: 'Impressions', format: (v) => Math.round(v).toLocaleString() },
  { key: 'clicks', label: 'Clicks', format: (v) => Math.round(v).toLocaleString() },
  { key: 'ctr', label: 'CTR', format: (v) => `${(v * 100).toFixed(2)}%` },
];

function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-950/90 backdrop-blur-md text-white text-xs rounded-xl p-3 shadow-xl border border-slate-800 space-y-1">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="font-bold flex items-center gap-1.5 text-sm">
          <span className={`w-1.5 h-1.5 rounded-full ${p.dataKey === 'plan' ? 'bg-slate-500' : 'bg-indigo-400'}`} />
          {p.dataKey === 'plan' ? 'Planned: ' : ''}{metric.format(p.value)} <span className="text-slate-400 text-[11px] font-medium">{metric.label.toLowerCase()}</span>
        </div>
      ))}
    </div>
  );
}

export default function PerformanceTrendCard({ series, targets, loading, onTargetSaved, showClicksProjectionNote = false }) {
  const [metricKey, setMetricKey] = useState('impressions');
  const [editing, setEditing] = useState(false);
  const metric = METRICS.find((m) => m.key === metricKey);
  const rows = (series || []).map((r) => ({
    date: r.date,
    value: metric.key === 'ctr'
      ? (Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0)
      : Number(r[metric.key] || 0),
  }));
  const target = targets?.[metricKey] || null;
  const chartRows = buildChartRows(rows, target);

  return (
    <div className="card p-6 flex flex-col justify-between">
      <div>
        <div className="flex flex-wrap items-start justify-between mb-6 gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">Performance Trend</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Daily {metric.label.toLowerCase()} over the selected range</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-slate-100/70 p-1 rounded-2xl border border-slate-200/40 shrink-0">
              {METRICS.map((m) => (
                <button key={m.key} onClick={() => { setMetricKey(m.key); setEditing(false); }}
                  className={`text-[11px] font-bold px-3 py-1.5 rounded-xl transition ${
                    metricKey === m.key
                      ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/20 active-pill-shadow'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}>
                  {m.label}
                </button>
              ))}
            </div>
            {metricKey === 'clicks' && showClicksProjectionNote ? (
              <span className="text-[9px] font-bold text-[#6C63FF] whitespace-nowrap">🎯 AI-projected above</span>
            ) : metricKey !== 'clicks' && !editing && (
              <button type="button" onClick={() => setEditing(true)} title={`Edit ${metric.label} growth target`}
                className="text-slate-300 hover:text-indigo-500 transition">
                <Target size={14} />
              </button>
            )}
          </div>
        </div>

        {editing && metricKey !== 'clicks' && (
          <GrowthTargetForm metric={metricKey} unit={metric.key === 'ctr' ? ' (0-1)' : ''} initial={target}
            onCancel={() => setEditing(false)}
            onSaved={() => { setEditing(false); onTargetSaved?.(); }} />
        )}

        {loading ? (
          <div className="py-20 text-center text-sm text-slate-400 animate-pulse font-medium">Loading trend…</div>
        ) : rows.length === 0 && !target ? (
          <div className="py-20 text-center text-sm text-slate-400 font-medium">No data for this range.</div>
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={chartRows} margin={{ top: 5, right: 8, left: -14, bottom: 0 }}>
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6C63FF" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#6C63FF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} width={44}
                tickFormatter={(v) => metric.key === 'ctr' ? `${Math.round(v * 100)}%` : v} />
              <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: '#e2e8f0', strokeWidth: 1 }} />
              {target?.baselineValue == null && target != null && (
                <ReferenceLine y={target.value} stroke="#6C63FF" strokeDasharray="5 5" strokeWidth={1.5}
                  label={{ value: `Goal: ${metric.format(target.value)} by ${String(target.date).slice(5, 10)}`, position: 'insideTopLeft', fontSize: 10, fill: '#6C63FF', fontWeight: 700 }} />
              )}
              <Area type="monotone" dataKey="value" stroke="#6C63FF" strokeWidth={2.5}
                fill="url(#trendFill)" dot={false} activeDot={{ r: 5, strokeWidth: 0, fill: '#6C63FF' }} connectNulls={false} />
              {target?.baselineValue != null && (
                <Line type="linear" dataKey="plan" stroke="#6C63FF" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} connectNulls name="Planned" />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <Link to="/insights"
        className="mt-4 pt-4 border-t border-slate-100 text-xs font-bold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto transition">
        View performance report <ArrowRight size={13} />
      </Link>
    </div>
  );
}
