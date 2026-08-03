import { Clock, AlertTriangle, Activity } from 'lucide-react';
import { TYPE_META, METHOD_LABEL, finding } from '../lib/analystFormat.js';

const ANOMALY_ICON = { high: AlertTriangle, low: Activity };

// Chronological, real events only — two distinct real backend records, not
// deduplicated against each other since they mean different things: a
// promoted Insight (anomaly/trend_shift/milestone/forecast_risk, from
// dashboard.insights, capped/filtered site-wide) vs. a raw statistical
// Anomaly row (metric.anomalies, up to 5 most recent for this metric,
// z-score/IQR detections that may or may not have been promoted). No
// external-event guessing (no "algorithm update detected") — nothing here
// without a real dated backend row behind it.
export default function AnalystInvestigationTimeline({ metric, insights }) {
  const insightEvents = insights
    .filter((i) => i.metric_key === metric.metric_key)
    .map((i) => ({
      date: i.period_start,
      label: finding(i, metric),
      typeLabel: TYPE_META[i.insight_type]?.label || i.insight_type,
      color: TYPE_META[i.insight_type]?.color || '#6C63FF',
      Icon: TYPE_META[i.insight_type]?.icon || Clock,
    }));

  const anomalyEvents = (metric.anomalies || []).map((a) => ({
    date: a.date,
    label: `${METHOD_LABEL[a.method] || a.method || 'Statistical'} anomaly · ${a.direction === 'high' ? 'above' : 'below'} normal range`,
    typeLabel: 'Anomaly',
    color: a.direction === 'high' ? '#e11d48' : '#0ea5e9',
    Icon: ANOMALY_ICON[a.direction] || AlertTriangle,
  }));

  const events = [...insightEvents, ...anomalyEvents].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);

  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Clock size={14} className="text-orange-500" />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">Investigation Timeline</h3>
      </div>

      {events.length === 0 ? (
        <p className="text-xs font-medium text-slate-400">No investigation events recorded for this metric yet.</p>
      ) : (
        <ol className="relative border-l-2 border-slate-150 ml-1.5 space-y-4">
          {events.map((e, idx) => (
            <li key={idx} className="pl-4 relative">
              <span
                className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full border-2 border-white grid place-items-center"
                style={{ backgroundColor: e.color }}
              >
                <e.Icon size={8} className="text-white" />
              </span>
              <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{e.date} · {e.typeLabel}</p>
              <p className="text-[11.5px] font-bold text-slate-700 mt-0.5">{e.label}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
