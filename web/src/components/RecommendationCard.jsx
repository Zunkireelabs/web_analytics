import { CATEGORY } from './AgentCard.jsx';

const IMPACT = {
  High: { color: '#16A34A', bg: '#f0fdf4' },
  Medium: { color: '#f59e0b', bg: '#fffbeb' },
  Low: { color: '#94a3b8', bg: '#f8fafc' },
};
const EFFORT_COLOR = { Low: '#16A34A', Medium: '#f59e0b', High: '#EF4444' };

// Colored left stripe keyed to Impact (the primary signal for "should I
// care about this one") — same accent-stripe language Command Center's
// finding cards already use, so severity reads before the text does.
export default function RecommendationCard({ title, reason, impact, effort, category }) {
  const cat = CATEGORY[category] || CATEGORY.seo;
  const imp = IMPACT[impact] || IMPACT.Low;
  return (
    <div className="flex rounded-xl border border-slate-100 bg-white overflow-hidden transition hover:border-slate-200 hover:shadow-[0_2px_10px_-4px_rgba(15,23,42,0.08)]">
      <div className="w-[3px] shrink-0" style={{ background: imp.color }} />
      <div className="flex items-start gap-3 p-3.5 flex-1 min-w-0">
        <span className="w-8 h-8 rounded-lg grid place-items-center text-sm shrink-0"
          style={{ background: `${cat.color}14`, color: cat.color }}>{cat.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800 leading-snug">{title}</div>
          <div className="text-xs text-slate-500 mt-0.5 leading-snug">{reason}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: imp.bg, color: imp.color }}>
            Impact: {impact}
          </span>
          <Pill label="Effort" value={effort} color={EFFORT_COLOR[effort]} />
        </div>
      </div>
    </div>
  );
}

function Pill({ label, value, color }) {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}1a`, color }}>
      {label}: {value}
    </span>
  );
}
