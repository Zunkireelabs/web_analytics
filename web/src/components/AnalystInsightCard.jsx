import { useState } from 'react';
import { SEVERITY_META, TYPE_META, finding, supportingLine } from '../lib/analystFormat.js';
import AnalystFindingPipeline from './AnalystFindingPipeline.jsx';

export default function AnalystInsightCard({
  insight, metric, clientId, onResolve, resolving, onDismiss, dismissing, onAnalyzeFurther,
}) {
  const [expanded, setExpanded] = useState(false);
  const type = TYPE_META[insight.insight_type] || TYPE_META.anomaly;
  const severity = SEVERITY_META[insight.severity] || SEVERITY_META.low;
  const Icon = type.icon;
  const e = insight.evidence || {};
  const isEarlyWarning = insight.insight_type === 'forecast_risk';

  return (
    <div className="rounded-3xl border border-slate-200/60 bg-gradient-to-br from-white to-slate-50/40 p-4 transition-all duration-300 hover:shadow-md hover:border-slate-300 relative overflow-hidden flex flex-col justify-between shadow-sm">
      <div className="absolute top-0 inset-x-0 h-1" style={{ background: `linear-gradient(90deg, ${type.color}, ${type.color}55)` }} />

      <div>
        <div className="flex items-start gap-3 mb-3.5">
          <span className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm mt-0.5"
            style={{ backgroundColor: `${type.color}0c`, color: type.color, borderColor: `${type.color}1a` }}>
            <Icon size={13} strokeWidth={2.25} />
          </span>
          <div className="min-w-0">
            <h4 className="text-sm font-black text-slate-900 leading-snug">{finding(insight, metric)}</h4>
            <p className="text-[10px] font-semibold text-slate-500 mt-1 leading-snug">{supportingLine(insight, metric)}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border"
            style={{ color: type.color, backgroundColor: `${type.color}0c`, borderColor: `${type.color}1e` }}>
            {type.label}
          </span>
          <span className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full border"
            style={{ color: severity.color, backgroundColor: severity.bg, borderColor: severity.border }}>
            {severity.label}
          </span>
          {isEarlyWarning && e.days_until_drop != null && (
            <span className="text-[9px] font-extrabold text-violet-600 bg-violet-50 px-2.5 py-0.5 rounded-full border border-violet-100 whitespace-nowrap">
              {e.days_until_drop <= 0 ? 'Due now' : `${e.days_until_drop}d out`}
            </span>
          )}
          <span className="text-[9px] text-slate-400 font-mono ml-auto">{insight.period_start}</span>
        </div>
      </div>

      {!expanded ? (
        <button type="button" onClick={() => setExpanded(true)}
          className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/80 hover:text-[#6C63FF] hover:underline mt-2 self-start min-h-[44px] flex items-center focus:outline-none cursor-pointer">
          Show investigation
        </button>
      ) : (
        <>
          <AnalystFindingPipeline
            insight={insight}
            metric={metric}
            clientId={clientId}
            onResolve={onResolve}
            resolving={resolving}
            onDismiss={onDismiss}
            dismissing={dismissing}
            onAnalyzeFurther={onAnalyzeFurther}
          />
          <button type="button" onClick={() => setExpanded(false)}
            className="text-[9px] font-black uppercase tracking-wider text-slate-400 hover:text-slate-600 focus:outline-none cursor-pointer min-h-[44px] flex items-center self-start">
            Hide
          </button>
        </>
      )}
    </div>
  );
}
