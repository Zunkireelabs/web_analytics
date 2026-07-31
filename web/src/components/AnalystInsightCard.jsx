import { useState } from 'react';
import { Clock, AlertTriangle, TrendingDown, TrendingUp, Award, CheckCircle2 } from 'lucide-react';

const SEVERITY_META = {
  high: { label: 'High', color: '#e11d48', bg: '#e11d480c', border: '#e11d481e' },
  medium: { label: 'Medium', color: '#ea580c', bg: '#ea580c0c', border: '#ea580c1e' },
  low: { label: 'Low', color: '#64748b', bg: '#64748b0c', border: '#64748b1e' },
};

const TYPE_META = {
  forecast_risk: { icon: Clock, label: 'Early Warning', color: '#8b5cf6' },
  anomaly: { icon: AlertTriangle, label: 'Anomaly', color: '#e11d48' },
  trend_shift: { icon: TrendingDown, label: 'Trend Shift', color: '#ea580c' },
  milestone: { icon: Award, label: 'Milestone', color: '#0ea5e9' },
};

function pct(v) {
  if (v == null) return '—';
  const rounded = Math.round(v * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function num(v) {
  if (v == null) return '—';
  return v !== 0 && Math.abs(v) < 1 ? v.toFixed(3) : Math.round(v).toLocaleString();
}

function headline(insight, metricLabel) {
  const e = insight.evidence || {};
  switch (insight.insight_type) {
    case 'forecast_risk':
      return `${metricLabel} predicted to fall ${pct(e.pct_projected_change)} by ${e.predicted_date || 'unknown date'}`;
    case 'anomaly':
      return `${metricLabel} anomaly — ${e.direction === 'high' ? 'unusually high' : 'unusually low'} (${e.method || 'stat'} score ${num(e.score)})`;
    case 'trend_shift':
      return `${metricLabel} ${e.period_type?.toUpperCase() || ''} shift: ${pct(e.pct_change)}`;
    case 'milestone':
      return `${metricLabel} crossed ${e.crossed_band} — now ${num(e.current_value)}`;
    default:
      return metricLabel;
  }
}

export default function AnalystInsightCard({ insight, metricLabel, onResolve, resolving }) {
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
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border"
              style={{ color: type.color, backgroundColor: `${type.color}0c`, borderColor: `${type.color}1e` }}>
              {type.label}
            </span>
            <span className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full border"
              style={{ color: severity.color, backgroundColor: severity.bg, borderColor: severity.border }}>
              {severity.label}
            </span>
          </div>
          {isEarlyWarning && e.days_until_drop != null && (
            <span className="text-[9px] font-extrabold text-violet-600 bg-violet-50 px-2.5 py-0.5 rounded-full border border-violet-100 whitespace-nowrap">
              {e.days_until_drop <= 0 ? 'Due now' : `${e.days_until_drop}d out`}
            </span>
          )}
        </div>

        <div className="flex items-start gap-3">
          <span className="w-7 h-7 rounded-xl grid place-items-center shrink-0 border shadow-sm"
            style={{ backgroundColor: `${type.color}0c`, color: type.color, borderColor: `${type.color}1a` }}>
            <Icon size={12} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-extrabold text-slate-900 leading-snug">{headline(insight, metricLabel)}</h4>
            <span className="inline-block text-[9px] text-slate-400 font-mono mt-0.5">{insight.period_start}</span>
          </div>
        </div>
      </div>

      {!expanded ? (
        <button type="button" onClick={() => setExpanded(true)}
          className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/80 hover:text-[#6C63FF] hover:underline mt-2 self-start py-2 focus:outline-none cursor-pointer">
          Show root cause & fix
        </button>
      ) : (
        <div className="flex flex-col gap-3 pt-2.5 border-t border-slate-100/50 mt-2 animate-slide-down">
          <div>
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1">Why</div>
            <p className="text-[10px] font-semibold text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-xl border border-slate-150">
              {insight.root_cause || 'Root-cause analysis runs nightly — check back after the next run.'}
            </p>
          </div>
          <div>
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1">Fix</div>
            <p className="text-[10px] font-semibold text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-xl border border-slate-150">
              {insight.recommendation || 'No recommendation generated yet.'}
            </p>
          </div>

          {e.correlated_anomalies?.length > 0 && (
            <div>
              <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1">Also moved same day</div>
              <div className="flex flex-wrap gap-1.5">
                {e.correlated_anomalies.map((c, i) => (
                  <span key={i} className="text-[9px] font-bold px-2 py-1 rounded-lg bg-slate-100 border border-slate-200 text-slate-600">
                    {c.metric_key} ({c.direction})
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" onClick={() => setExpanded(false)}
              className="text-[9px] font-black uppercase tracking-wider text-slate-400 hover:text-slate-600 focus:outline-none cursor-pointer">
              Hide
            </button>
            <button
              type="button"
              onClick={() => onResolve(insight)}
              disabled={!insight.recommendation_id || resolving}
              title={!insight.recommendation_id ? 'No recommendation to resolve yet' : undefined}
              className="inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider px-3 py-2 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              <CheckCircle2 size={11} /> {resolving ? 'Marking…' : 'Mark solved'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
