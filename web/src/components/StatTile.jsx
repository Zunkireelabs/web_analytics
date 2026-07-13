import { useCountUp } from '../useCountUp.js';

const TONE_CLASS = { critical: 'text-rose-600', accent: 'text-[#6C63FF]', default: 'text-slate-900' };

// Minimal KPI tile — no chart, no icon. The Command Center deliberately
// avoids dashboard-filler visuals; a number + one line of context is enough
// at this altitude (detail lives in the sections below, not here). Numeric
// values count up on arrival instead of just appearing.
export default function StatTile({ label, value, sub, tone = 'default', loading }) {
  const animated = useCountUp(value);

  if (loading) {
    return (
      <div className="card p-4">
        <div className="h-3 w-20 bg-slate-100 rounded animate-pulse mb-2.5" />
        <div className="h-7 w-14 bg-slate-200 rounded animate-pulse" />
      </div>
    );
  }
  return (
    <div className="card card-hover p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${TONE_CLASS[tone] || TONE_CLASS.default}`}>
        {typeof value === 'number' ? animated : value}
      </div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}
