import { CATEGORY } from './AgentCard.jsx';

const IMPACT_COLOR = { High: '#16A34A', Medium: '#f59e0b', Low: '#94a3b8' };
const EFFORT_COLOR = { Low: '#16A34A', Medium: '#f59e0b', High: '#EF4444' };

export default function RecommendationCard({ title, reason, impact, effort, category }) {
  const cat = CATEGORY[category] || CATEGORY.seo;
  return (
    <div className="flex items-start gap-3 p-3.5 rounded-xl border border-slate-100 hover:bg-slate-50/60 transition">
      <span className="w-8 h-8 rounded-lg grid place-items-center text-sm shrink-0"
        style={{ background: `${cat.color}1a`, color: cat.color }}>{cat.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-800 leading-snug">{title}</div>
        <div className="text-xs text-slate-500 mt-0.5 leading-snug">{reason}</div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Pill label="Impact" value={impact} color={IMPACT_COLOR[impact]} />
        <Pill label="Effort" value={effort} color={EFFORT_COLOR[effort]} />
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
