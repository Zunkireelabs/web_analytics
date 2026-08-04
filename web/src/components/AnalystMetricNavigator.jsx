import { useMemo, useState } from 'react';
import { Search, TrendingUp, TrendingDown, Minus, Activity, Target, ShieldCheck, Sparkles, Building2, LayoutGrid } from 'lucide-react';
import { formatByUnit, SEVERITY_META } from '../lib/analystFormat.js';

// Icon and filter chips are keyed off metrics_catalog.dashboard_group — the
// one real categorical field the backend actually populates per metric
// (metrics_catalog.icon is null for every row today, so it can't drive
// this). Falls back to a generic icon for any group not in this map rather
// than guessing, since dashboard_group is catalog-driven and can grow.
const GROUP_ICON = {
  'Search Performance': Search,
  'Engagement': Activity,
  'Conversions': Target,
  'Health & Authority': ShieldCheck,
  'AI Visibility': Sparkles,
  'Competitors': Building2,
};

function TrendArrow({ direction, size = 11 }) {
  if (direction === 'up') return <TrendingUp size={size} className="text-emerald-500" />;
  if (direction === 'down') return <TrendingDown size={size} className="text-rose-500" />;
  return <Minus size={size} className="text-slate-400" />;
}

// Same status logic as the rest of the Analyst page: an active insight's
// severity wins (High/Medium/Low, real SEVERITY_META colors); short of
// that, a recent anomaly on the metric itself gets a plain "Anomaly" note;
// otherwise the metric reads as stable. Never a fabricated risk score.
function statusFor(metric, severity) {
  if (severity) return { label: SEVERITY_META[severity].label, color: SEVERITY_META[severity].color, bg: SEVERITY_META[severity].bg };
  if (metric.anomalies?.length) return { label: 'Anomaly', color: '#ea580c', bg: '#ea580c0c' };
  return { label: 'Stable', color: '#64748b', bg: '#64748b0c' };
}

export default function AnalystMetricNavigator({ metrics, insights, selectedMetricKey, onSelect }) {
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState('All');

  const groups = useMemo(() => ['All', ...new Set(metrics.map((m) => m.dashboard_group).filter(Boolean))], [metrics]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return metrics.filter((m) => {
      if (activeGroup !== 'All' && m.dashboard_group !== activeGroup) return false;
      if (q && !m.display_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [metrics, query, activeGroup]);

  const severityFor = (metricKey) => insights.find((i) => i.metric_key === metricKey)?.severity;

  return (
    <div className="card p-0 flex flex-col overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50/60 px-2.5 py-1.5">
          <Search size={12} className="text-slate-400 shrink-0" />
          <input
            type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search metrics…"
            className="w-full bg-transparent text-xs font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto">
        {groups.map((g) => (
          <button
            key={g} type="button" onClick={() => setActiveGroup(g)}
            className={`shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full border transition ${
              activeGroup === g
                ? 'bg-indigo-600 border-indigo-600 text-white'
                : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 && (
          <p className="text-[11px] font-medium text-slate-400 px-2 py-3">No metrics match.</p>
        )}
        {rows.map((m) => {
          const wow = m.period_stats?.wow;
          const direction = wow?.pct_change > 0 ? 'up' : wow?.pct_change < 0 ? 'down' : 'flat';
          const Icon = GROUP_ICON[m.dashboard_group] || LayoutGrid;
          const status = statusFor(m, severityFor(m.metric_key));
          const active = m.metric_key === selectedMetricKey;
          return (
            <button
              key={m.metric_key} type="button" onClick={() => onSelect(m.metric_key)}
              className={`w-full text-left flex flex-col gap-1.5 px-2.5 py-2 rounded-xl mb-1 transition ${
                active ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-5 h-5 rounded-lg grid place-items-center shrink-0 ${active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                  <Icon size={11} />
                </span>
                <span className="text-[11.5px] font-bold text-slate-800 truncate flex-1">{m.display_name}</span>
                <TrendArrow direction={direction} />
              </div>
              <div className="flex items-center gap-1.5 pl-7">
                <span className="text-[11px] font-extrabold text-slate-700 tabular-nums">{formatByUnit(m.latest_value, m.unit)}</span>
                <span
                  className="ml-auto text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                  style={{ color: status.color, backgroundColor: status.bg }}
                >
                  {status.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
