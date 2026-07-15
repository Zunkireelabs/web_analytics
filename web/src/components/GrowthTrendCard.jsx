import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

// Generic single-metric trend card for the Growth page — health score,
// competitor readiness, Authority Score, AI Recommendation rate all share
// this same real "first -> latest, real delta, real series" shape (see
// server/agents/lib/growth-report.js's summarize* helpers), unlike
// PerformanceTrendCard which is specifically shaped for the 3-metric GSC
// toggle. Every empty/singular state here reflects real sparse data, never
// a fabricated line to fill the chart.

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <div className="text-slate-300 mb-0.5">{label}</div>
      <div className="font-semibold">{payload[0].value}{unit}</div>
    </div>
  );
}

export default function GrowthTrendCard({ id, title, subtitle, icon, color = '#6C63FF', unit = '', data, loading, emptyMessage }) {
  const rows = (data?.series || []).map((r) => ({
    date: String(r.date).slice(0, 10).slice(5),
    value: r.value ?? r.score ?? r.mentionRate ?? null,
  })).filter((r) => r.value != null);

  return (
    <div className="card p-6 flex flex-col h-full">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">{icon} {title}</h3>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        {rows.length >= 2 && data.delta != null && (
          <span className={`text-xs font-bold px-2 py-1 rounded-full shrink-0 ${data.delta >= 0 ? 'text-emerald-700 bg-emerald-50' : 'text-rose-700 bg-rose-50'}`}>
            {data.delta >= 0 ? '+' : ''}{data.delta}{unit}
          </span>
        )}
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400 animate-pulse flex-1 flex items-center justify-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400 flex-1 flex items-center justify-center font-medium leading-relaxed">{emptyMessage || 'No real data yet.'}</div>
      ) : rows.length === 1 ? (
        <div className="py-6 text-center flex-1 flex flex-col justify-center">
          <p className="text-3xl font-bold text-slate-900">{rows[0].value}{unit}</p>
          <p className="text-xs text-slate-400 mt-1">Only one real data point so far — a trend needs at least two.</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col justify-end mt-auto">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<CustomTooltip unit={unit} />} />
              <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2.5} fill={`url(#fill-${id})`} dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
