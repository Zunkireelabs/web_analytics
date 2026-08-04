import { useMemo } from 'react';
import {
  ShieldAlert, CheckCircle2, Ban, ArrowUpRight, Radar, Clock, AlertTriangle, TrendingDown, Award, ListChecks, Activity,
} from 'lucide-react';
import { TYPE_META, SEVERITY_META, finding, supportingLine } from '../lib/analystFormat.js';
import AnalystEmptyState from './AnalystEmptyState.jsx';

// The analyst page's own "fix it before it breaks" action board. Columns
// are genuine categories of the real insight stream:
//   Prevent  — forecast_risk early warnings (the whole point of a
//              proactive analyst: the fix exists before the drop lands)
//   Triage   — high/medium severity anomalies & trend shifts, actionable now
//   Monitor  — low-severity / milestone signals to keep an eye on
// Nothing here is fabricated: every card is a real Insight row from the
// dashboard payload, and the action buttons reuse the same resolve/dismiss
// paths as the Investigation Workspace.
const SEV_RANK = { high: 0, medium: 1, low: 2 };

export default function AnalystProactiveActionBoard({
  clientId,
  insights = [],
  metricFor,
  onResolve,
  resolvingId,
  onDismiss,
  dismissingId,
  onAnalyzeFurther,
  onOpenFinding,
}) {
  const columns = useMemo(() => {
    const sorted = [...insights].sort((a, b) => {
      const sev = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
      if (sev !== 0) return sev;
      return b.period_start.localeCompare(a.period_start);
    });
    return {
      prevent: sorted.filter((i) => i.insight_type === 'forecast_risk'),
      triage: sorted.filter((i) => i.insight_type !== 'forecast_risk' && (i.severity === 'high' || i.severity === 'medium')),
      monitor: sorted.filter((i) => i.insight_type !== 'forecast_risk' && i.severity === 'low'),
    };
  }, [insights]);

  const counts = {
    prevent: columns.prevent.length,
    triage: columns.triage.length,
    monitor: columns.monitor.length,
  };
  const total = insights.length;

  if (total === 0) {
    return (
      <div className="an-panel p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-xl bg-emerald-50 border border-emerald-500/25 text-emerald-600 grid place-items-center">
            <ShieldAlert size={15} />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">Proactive Fix Board</h3>
            <p className="text-[10px] font-medium text-slate-400">Predictions & fixes generated before issues surface</p>
          </div>
        </div>
        <AnalystEmptyState
          icon={CheckCircle2}
          title="All Clear — No Active Fixes"
          description="No predicted risks, anomalies, or trend shifts detected. The analyst will generate fixes here the moment anything is flagged."
          compact
        />
      </div>
    );
  }

  const columnsConfig = [
    { key: 'prevent', title: 'Prevent', sub: 'Predicted before it breaks', icon: Radar, color: '#fb7185', items: columns.prevent, tone: 'rose' },
    { key: 'triage', title: 'Triage Now', sub: 'Actionable findings', icon: AlertTriangle, color: '#fbbf24', items: columns.triage, tone: 'amber' },
    { key: 'monitor', title: 'Monitor', sub: 'Low-key signals', icon: Activity, color: '#38bdf8', items: columns.monitor, tone: 'cyan' },
  ];

  return (
    <div className="an-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-500 grid place-items-center">
            <ListChecks size={15} />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">Proactive Fix Board</h3>
            <p className="text-[10px] font-medium text-slate-400">
              {total} live {total === 1 ? 'finding' : 'findings'} · fixes generated the moment a risk is predicted
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="an-chip an-chip-rose">Prevent {counts.prevent}</span>
          <span className="an-chip an-chip-amber">Triage {counts.triage}</span>
          <span className="an-chip an-chip-cyan">Monitor {counts.monitor}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        {columnsConfig.map((col) => (
          <Column key={col.key} {...col}
            metricFor={metricFor}
            onResolve={onResolve} resolvingId={resolvingId}
            onDismiss={onDismiss} dismissingId={dismissingId}
            onAnalyzeFurther={onAnalyzeFurther} onOpenFinding={onOpenFinding} />
        ))}
      </div>
    </div>
  );
}

function Column({ title, sub, icon: Icon, color, items, metricFor, onResolve, resolvingId, onDismiss, dismissingId, onAnalyzeFurther, onOpenFinding }) {
  return (
    <div className="rounded-2xl bg-slate-100/40 border border-slate-200 p-3 flex flex-col min-h-[160px]">
      <div className="flex items-center gap-2 mb-3 px-1">
        <span className="w-6 h-6 rounded-lg grid place-items-center border shrink-0" style={{ color, backgroundColor: `${color}14`, borderColor: `${color}2e` }}>
          <Icon size={12} />
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wider text-slate-900 leading-none">{title}</div>
          <div className="text-[9px] font-medium text-slate-500 mt-0.5">{sub}</div>
        </div>
        <span className="ml-auto text-[10px] font-black text-slate-400 font-mono">{items.length}</span>
      </div>

      {items.length === 0 ? (
        <p className="text-[10px] font-medium text-slate-500 px-1 pb-2 text-center py-4">Nothing here right now.</p>
      ) : (
        <div className="space-y-2">
          {items.map((i) => (
            <FixCard key={i.id} insight={i} metric={metricFor(i.metric_key)}
              onResolve={onResolve} resolving={resolvingId === i.recommendation_id}
              onDismiss={onDismiss} dismissing={dismissingId === i.recommendation_id}
              onAnalyzeFurther={() => onAnalyzeFurther(i.metric_key)}
              onOpenFinding={onOpenFinding ? () => onOpenFinding(i.id) : null} />
          ))}
        </div>
      )}
    </div>
  );
}

function FixCard({ insight, metric, onResolve, resolving, onDismiss, dismissing, onAnalyzeFurther, onOpenFinding }) {
  const type = TYPE_META[insight.insight_type] || TYPE_META.anomaly;
  const sev = SEVERITY_META[insight.severity] || SEVERITY_META.low;
  const Icon = type.icon;
  const e = insight.evidence || {};
  const hasRecommendation = Boolean(insight.recommendation_id);
  const isPreventive = insight.insight_type === 'forecast_risk';
  const daysUntil = isPreventive ? e.days_until_drop : null;

  return (
    <div className={`rounded-2xl border p-3 transition group ${isPreventive ? 'bg-rose-50 border-rose-500/25' : 'bg-slate-100/50 border-slate-200'} hover:border-indigo-400 hover:bg-slate-100/70`}>
      <div className="flex items-start gap-2.5">
        <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0 border mt-0.5" style={{ backgroundColor: `${type.color}12`, borderColor: `${type.color}25`, color: type.color }}>
          <Icon size={12} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1">
          {isPreventive && daysUntil != null && (
            <span className={`an-chip mb-1.5 ${daysUntil <= 0 ? 'an-chip-rose' : daysUntil <= 3 ? 'an-chip-amber' : 'an-chip-violet'}`}>
              <Clock size={9} />
              {daysUntil <= 0 ? 'Due now' : `${daysUntil}d until drop`}
            </span>
          )}
          <button type="button" onClick={onOpenFinding} className="text-left w-full focus:outline-none cursor-pointer">
            <p className="text-[11.5px] font-bold text-slate-100 leading-snug group-hover:text-slate-900 transition">
              {finding(insight, metric)}
            </p>
          </button>
          <p className="text-[9.5px] font-semibold text-slate-500 mt-1 leading-snug">{supportingLine(insight, metric)}</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-white/5 flex-wrap">
        <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ color: sev.color, backgroundColor: sev.bg }}>
          {sev.label}
        </span>
        {hasRecommendation && (
          <span className="an-chip an-chip-emerald !px-1.5 !py-0"><CheckCircle2 size={9} /> fix ready</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onAnalyzeFurther}
            className="p-1 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition cursor-pointer"
            title="Analyze further"
          >
            <ArrowUpRight size={11} />
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(insight)}
              disabled={!hasRecommendation || dismissing}
              className="p-1 rounded-md text-slate-500 hover:text-amber-600 hover:bg-slate-100 transition disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Dismiss"
            >
              <Ban size={11} />
            </button>
          )}
          {onResolve && (
            <button
              type="button"
              onClick={() => onResolve(insight)}
              disabled={!hasRecommendation || resolving}
              className="p-1 rounded-md text-slate-500 hover:text-emerald-600 hover:bg-slate-100 transition disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Mark solved"
            >
              {resolving ? <span className="inline-block w-2.5 h-2.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" /> : <CheckCircle2 size={11} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}