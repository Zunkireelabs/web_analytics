import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ArrowRight } from 'lucide-react';

const METRICS = [
  { key: 'impressions', label: 'Impressions', format: (v) => Math.round(v).toLocaleString() },
  { key: 'clicks', label: 'Clicks', format: (v) => Math.round(v).toLocaleString() },
  { key: 'ctr', label: 'CTR', format: (v) => `${(v * 100).toFixed(2)}%` },
];

function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <div className="text-slate-300 mb-0.5">{label}</div>
      <div className="font-semibold">{metric.format(payload[0].value)} {metric.label.toLowerCase()}</div>
    </div>
  );
}

export default function PerformanceTrendCard({ series, loading }) {
  const [metricKey, setMetricKey] = useState('impressions');
  const metric = METRICS.find((m) => m.key === metricKey);
  const rows = (series || []).map((r) => ({
    date: String(r.date).slice(5),
    value: metric.key === 'ctr'
      ? (Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0)
      : Number(r[metric.key] || 0),
  }));

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">Performance Trend</h3>
          <p className="text-xs text-slate-400 mt-0.5">Daily {metric.label.toLowerCase()} over the selected range</p>
        </div>
        <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/30 shrink-0">
          {METRICS.map((m) => (
            <button key={m.key} onClick={() => setMetricKey(m.key)}
              className={`text-[11px] px-2.5 py-1 font-semibold rounded-lg transition ${
                metricKey === m.key ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-slate-400 animate-pulse">Loading trend…</div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-400">No data for this range.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6C63FF" stopOpacity={0.18} />
                <stop offset="100%" stopColor="#6C63FF" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={44}
              tickFormatter={(v) => metric.key === 'ctr' ? `${Math.round(v * 100)}%` : v} />
            <Tooltip content={<CustomTooltip metric={metric} />} />
            <Area type="monotone" dataKey="value" stroke="#6C63FF" strokeWidth={2.5}
              fill="url(#trendFill)" dot={false} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      )}

      <Link to="/insights"
        className="mt-auto pt-3 border-t border-slate-50 text-sm font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto">
        View performance report <ArrowRight size={14} />
      </Link>
    </div>
  );
}
