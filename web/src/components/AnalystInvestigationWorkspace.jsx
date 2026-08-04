import { useEffect, useState, useMemo } from 'react';
import { ChevronRight, Inbox, Search } from 'lucide-react';
import { SEVERITY_META, TYPE_META, finding } from '../lib/analystFormat.js';
import AnalystFindingPipeline from './AnalystFindingPipeline.jsx';
import AnalystEmptyState from './AnalystEmptyState.jsx';

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

export default function AnalystInvestigationWorkspace({
  clientId,
  insights,
  metricFor,
  onResolve,
  resolvingId,
  onDismiss,
  dismissingId,
  onAnalyzeFurther,
  externalSelectedId,
}) {
  const [filterSev, setFilterSev] = useState('all');
  const [filterQuery, setFilterQuery] = useState('');

  const sorted = useMemo(() => {
    return [...insights].sort((a, b) => {
      const sevDiff = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      return b.period_start.localeCompare(a.period_start);
    });
  }, [insights]);

  const filtered = useMemo(() => {
    return sorted.filter((i) => {
      if (filterSev !== 'all' && i.severity !== filterSev) return false;
      if (filterQuery.trim()) {
        const q = filterQuery.toLowerCase();
        const text = (finding(i, metricFor(i.metric_key)) + ' ' + (i.metric_key || '')).toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [sorted, filterSev, filterQuery, metricFor]);

  const [selectedId, setSelectedId] = useState(externalSelectedId || sorted[0]?.id || null);

  useEffect(() => {
    if (externalSelectedId) {
      setSelectedId(externalSelectedId);
    } else if (!filtered.some((i) => i.id === selectedId)) {
      setSelectedId(filtered[0]?.id || sorted[0]?.id || null);
    }
  }, [insights, externalSelectedId, filtered]);

  if (sorted.length === 0) {
    return (
      <div className="an-panel p-6">
        <AnalystEmptyState
          icon={Inbox}
          title="No Active Investigations"
          description="No predicted risks, anomalies, trend shifts, or milestones detected for this client in the active timeframe."
          compact
        />
      </div>
    );
  }

  const selected = sorted.find((i) => i.id === selectedId) || filtered[0] || sorted[0];
  const selectedMetric = selected ? metricFor(selected.metric_key) : null;
  const related = selected
    ? sorted
        .filter(
          (i) =>
            i.id !== selected.id &&
            (i.metric_key === selected.metric_key ||
              (selected.dimension_value && i.dimension_value === selected.dimension_value))
        )
        .slice(0, 3)
    : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
      {/* Left Pane: Triage List (Compact Capped Height) */}
      <div className="an-panel p-3 max-h-80 overflow-y-auto space-y-2 custom-scrollbar">
        {/* Search & Severity Filter */}
        <div className="space-y-1.5 pb-2 border-b border-slate-200">
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100/80 px-2 py-1">
            <Search size={11} className="text-slate-500 shrink-0" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter findings..."
              className="w-full bg-transparent text-[11px] font-semibold text-slate-800 placeholder:text-slate-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {['all', 'high', 'medium', 'low'].map((sev) => {
              const active = filterSev === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setFilterSev(sev)}
                  className={`text-[8.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border transition capitalize ${
                    active
                      ? 'bg-slate-100 border-white/15 text-slate-900'
                      : 'bg-slate-200/60 border-slate-200 text-slate-400 hover:text-slate-800'
                  }`}
                >
                  {sev}
                </button>
              );
            })}
          </div>
        </div>

        {/* Item List */}
        {filtered.length === 0 ? (
          <p className="text-[10.5px] font-medium text-slate-500 p-3 text-center">
            No findings match filter.
          </p>
        ) : (
          filtered.map((i) => {
            const type = TYPE_META[i.insight_type] || TYPE_META.anomaly;
            const sev = SEVERITY_META[i.severity] || SEVERITY_META.low;
            const Icon = type.icon;
            const active = i.id === selected?.id;
            return (
              <button
                key={i.id}
                type="button"
                onClick={() => setSelectedId(i.id)}
                className={`w-full text-left flex items-start gap-2 p-2 rounded-xl transition border ${
                  active
                    ? 'bg-indigo-50 border-indigo-300'
                    : 'bg-slate-100/70 border-slate-200 hover:border-slate-300/70 hover:bg-slate-100'
                }`}
              >
                <span
                  className="w-6 h-6 rounded-lg grid place-items-center shrink-0 border mt-0.5"
                  style={{
                    backgroundColor: `${type.color}12`,
                    borderColor: `${type.color}25`,
                    color: type.color,
                  }}
                >
                  <Icon size={12} />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold text-slate-800 leading-tight truncate">
                    {finding(i, metricFor(i.metric_key))}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span
                      className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.2 rounded"
                      style={{ color: sev.color, backgroundColor: sev.bg }}
                    >
                      {sev.label}
                    </span>
                    <span className="text-[8.5px] font-semibold text-slate-500 ml-auto">
                      {i.period_start}
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Right Pane: Selected Finding Investigation Detail (Capped Height Scrollable) */}
      {selected ? (
        <div className="an-panel p-5 min-w-0 max-h-80 overflow-y-auto custom-scrollbar">
          <DetailHeader insight={selected} metric={selectedMetric} />
          <AnalystFindingPipeline
            insight={selected}
            metric={selectedMetric}
            clientId={clientId}
            onResolve={onResolve}
            resolving={resolvingId === selected.recommendation_id}
            onDismiss={onDismiss}
            dismissing={dismissingId === selected.recommendation_id}
            onAnalyzeFurther={() => onAnalyzeFurther(selected.metric_key)}
          />

          {related.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-200">
              <h4 className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
                Related findings
              </h4>
              <div className="flex flex-col gap-1">
                {related.map((r) => {
                  const type = TYPE_META[r.insight_type] || TYPE_META.anomaly;
                  const Icon = type.icon;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className="flex items-center gap-2 p-1.5 rounded-lg border border-slate-200 bg-slate-100/70 hover:bg-slate-100 hover:border-indigo-300 transition text-left cursor-pointer"
                    >
                      <span
                        className="w-5 h-5 rounded-md grid place-items-center shrink-0"
                        style={{ backgroundColor: `${type.color}14`, color: type.color }}
                      >
                        <Icon size={11} />
                      </span>
                      <span className="text-[10px] font-bold text-slate-700 flex-1 truncate">
                        {finding(r, metricFor(r.metric_key))}
                      </span>
                      <ChevronRight size={12} className="text-slate-500 shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="an-panel p-6">
          <AnalystEmptyState
            title="Select a Finding"
            description="Choose a finding from the left pane to investigate root cause & forecast impact."
            compact
          />
        </div>
      )}
    </div>
  );
}

function DetailHeader({ insight, metric }) {
  const type = TYPE_META[insight.insight_type] || TYPE_META.anomaly;
  const sev = SEVERITY_META[insight.severity] || SEVERITY_META.low;
  const Icon = type.icon;
  return (
    <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-200">
      <span
        className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border"
        style={{
          backgroundColor: `${type.color}0c`,
          color: type.color,
          borderColor: `${type.color}20`,
        }}
      >
        <Icon size={15} strokeWidth={2.25} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[9.5px] font-black uppercase tracking-wider" style={{ color: type.color }}>
          {type.label} · {metric?.display_name || insight.metric_key}
        </p>
        <h3 className="text-sm font-black text-slate-100 leading-snug mt-0.5">
          {finding(insight, metric)}
        </h3>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span
            className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.2 rounded border"
            style={{ color: sev.color, backgroundColor: sev.bg, borderColor: sev.border }}
          >
            {sev.label} severity
          </span>
          <span className="text-[10px] font-semibold text-slate-500">
            Detected {insight.period_start}
          </span>
        </div>
      </div>
    </div>
  );
}
