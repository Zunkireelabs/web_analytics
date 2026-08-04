import { useMemo, useState } from 'react';
import { Search, TrendingUp, TrendingDown, Minus, Activity, Target, ShieldCheck, Sparkles, Building2, LayoutGrid, Filter } from 'lucide-react';
import { formatByUnit, SEVERITY_META } from '../lib/analystFormat.js';
import AnalystEmptyState from './AnalystEmptyState.jsx';

const GROUP_ICON = {
  'Search Performance': Search,
  'Engagement': Activity,
  'Conversions': Target,
  'Health & Authority': ShieldCheck,
  'AI Visibility': Sparkles,
  'Competitors': Building2,
};

function TrendArrow({ direction, size = 11 }) {
  if (direction === 'up') return <TrendingUp size={size} className="text-emerald-600" />;
  if (direction === 'down') return <TrendingDown size={size} className="text-rose-600" />;
  return <Minus size={size} className="text-slate-400" />;
}

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

  if (metrics.length === 0) {
    return (
      <div className="an-panel p-4">
        <AnalystEmptyState
          icon={LayoutGrid}
          title="No Metrics Catalog"
          description="Ingest search or analytics data to generate metric catalog."
          compact
        />
      </div>
    );
  }

  return (
    <div className="an-panel p-0 flex flex-col overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
      <div className="p-3 pb-2 border-b border-slate-200">
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-100/80 px-2.5 py-1.5">
          <Search size={12} className="text-slate-500 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search metrics..."
            className="w-full bg-transparent text-xs font-semibold text-slate-800 placeholder:text-slate-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-200 overflow-x-auto no-scrollbar">
        {groups.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setActiveGroup(g)}
            className={`shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full border transition cursor-pointer ${
              activeGroup === g
                ? 'bg-violet-600 border-violet-600 text-slate-900'
                : 'bg-slate-100/80 border-slate-200 text-slate-400 hover:border-slate-500'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {rows.length === 0 && (
          <p className="text-[11px] font-medium text-slate-500 px-2 py-4 text-center">No metrics match search.</p>
        )}
        {rows.map((m) => {
          const wow = m.period_stats?.wow;
          const direction = wow?.pct_change > 0 ? 'up' : wow?.pct_change < 0 ? 'down' : 'flat';
          const Icon = GROUP_ICON[m.dashboard_group] || LayoutGrid;
          const status = statusFor(m, severityFor(m.metric_key));
          const active = m.metric_key === selectedMetricKey;
          return (
            <button
              key={m.metric_key}
              type="button"
              onClick={() => onSelect(m.metric_key)}
              className={`w-full text-left flex flex-col gap-1.5 px-3 py-2.5 rounded-2xl transition border cursor-pointer ${
                active
                  ? 'bg-indigo-50 border-indigo-300 text-slate-900 ring-1 ring-violet-500/30'
                  : 'bg-slate-100/70 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-5 h-5 rounded-lg grid place-items-center shrink-0 ${
                    active ? 'bg-violet-600 text-slate-900' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  <Icon size={11} />
                </span>
                <span className="text-[11.5px] font-bold text-slate-800 truncate flex-1">{m.display_name}</span>
                <TrendArrow direction={direction} />
              </div>
              <div className="flex items-center justify-between pl-7">
                <span className="text-[11px] font-extrabold text-slate-700 tabular-nums">
                  {formatByUnit(m.latest_value, m.unit)}
                </span>
                <span
                  className="text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md"
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
