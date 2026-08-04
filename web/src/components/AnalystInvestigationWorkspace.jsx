import { useEffect, useState } from 'react';
import { ChevronRight, Inbox } from 'lucide-react';
import { SEVERITY_META, TYPE_META, finding } from '../lib/analystFormat.js';
import AnalystFindingPipeline from './AnalystFindingPipeline.jsx';

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// Same real detail content as before (AnalystFindingPipeline — Root Cause,
// Repair Strategy, Forecast, Projected Impact, Opportunity Score, Execution
// Actions, AI Action Pipeline, AI Reasoning Panel — all already real,
// nothing rewritten here), just re-housed as a persistent two-pane list +
// detail instead of a grid of independently-expanding cards. Only one
// investigation open at a time, matching the approved design.
export default function AnalystInvestigationWorkspace({
  clientId, insights, metricFor, onResolve, resolvingId, onDismiss, dismissingId, onAnalyzeFurther,
}) {
  const sorted = [...insights].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.period_start.localeCompare(a.period_start);
  });

  const [selectedId, setSelectedId] = useState(sorted[0]?.id ?? null);
  useEffect(() => {
    if (!sorted.some((i) => i.id === selectedId)) setSelectedId(sorted[0]?.id ?? null);
  }, [insights]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sorted.length === 0) {
    return (
      <div className="card p-8 flex flex-col items-center text-center gap-2">
        <Inbox size={20} className="text-slate-300" />
        <p className="text-xs font-semibold text-slate-400">No forecasted risks, anomalies, trend shifts, or milestones to review right now.</p>
      </div>
    );
  }

  const selected = sorted.find((i) => i.id === selectedId) || sorted[0];
  const selectedMetric = metricFor(selected.metric_key);
  const related = sorted.filter((i) => i.id !== selected.id && (
    i.metric_key === selected.metric_key
    || (selected.dimension_value && i.dimension_value === selected.dimension_value)
  )).slice(0, 4);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
      <div className="card p-2 max-h-[calc(100vh-8rem)] overflow-y-auto lg:sticky lg:top-4">
        {sorted.map((i) => {
          const type = TYPE_META[i.insight_type] || TYPE_META.anomaly;
          const sev = SEVERITY_META[i.severity] || SEVERITY_META.low;
          const Icon = type.icon;
          const active = i.id === selected.id;
          return (
            <button
              key={i.id} type="button" onClick={() => setSelectedId(i.id)}
              className={`w-full text-left flex items-start gap-2.5 p-2.5 rounded-2xl mb-1 transition ${
                active ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50'
              }`}
            >
              <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0" style={{ backgroundColor: `${type.color}14`, color: type.color }}>
                <Icon size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-bold text-slate-800 leading-snug line-clamp-2">{finding(i, metricFor(i.metric_key))}</p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md" style={{ color: sev.color, backgroundColor: sev.bg }}>
                    {sev.label}
                  </span>
                  <span className="text-[9px] font-semibold text-slate-400 ml-auto">{i.period_start}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="card p-6 min-w-0">
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
          <div className="mt-5 pt-4 border-t border-slate-100">
            <h4 className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-2">Related findings — same metric or dimension</h4>
            <div className="flex flex-col gap-1.5">
              {related.map((r) => {
                const type = TYPE_META[r.insight_type] || TYPE_META.anomaly;
                const Icon = type.icon;
                return (
                  <button
                    key={r.id} type="button" onClick={() => setSelectedId(r.id)}
                    className="flex items-center gap-2 p-2 rounded-xl border border-slate-150 hover:border-slate-300 hover:bg-slate-50/60 transition text-left"
                  >
                    <span className="w-6 h-6 rounded-lg grid place-items-center shrink-0" style={{ backgroundColor: `${type.color}14`, color: type.color }}>
                      <Icon size={11} />
                    </span>
                    <span className="text-[10.5px] font-bold text-slate-700 flex-1 truncate">{finding(r, metricFor(r.metric_key))}</span>
                    <ChevronRight size={12} className="text-slate-300 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailHeader({ insight, metric }) {
  const type = TYPE_META[insight.insight_type] || TYPE_META.anomaly;
  const sev = SEVERITY_META[insight.severity] || SEVERITY_META.low;
  const Icon = type.icon;
  return (
    <div className="flex items-start gap-3 mb-5 pb-5 border-b border-slate-100">
      <span className="w-9 h-9 rounded-xl grid place-items-center shrink-0 border shadow-sm" style={{ backgroundColor: `${type.color}0c`, color: type.color, borderColor: `${type.color}1a` }}>
        <Icon size={16} strokeWidth={2.25} />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: type.color }}>{type.label} · {metric.display_name}</p>
        <h3 className="text-base font-black text-slate-900 leading-snug mt-0.5">{finding(insight, metric)}</h3>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full border" style={{ color: sev.color, backgroundColor: sev.bg, borderColor: sev.border }}>
            {sev.label} severity
          </span>
          <span className="text-[10.5px] font-semibold text-slate-400">Detected {insight.period_start}</span>
          {insight.dimension_type && insight.dimension_type !== 'site' && insight.dimension_value && (
            <span className="text-[10.5px] font-semibold text-slate-400">Scope: {insight.dimension_type} “{insight.dimension_value}”</span>
          )}
        </div>
      </div>
    </div>
  );
}
