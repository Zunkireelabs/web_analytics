import { CATEGORY } from './AgentCard.jsx';
import { Target, Globe, FileText, Brain } from 'lucide-react';

const ICONS = {
  seo: Target,
  geo: Globe,
  content: FileText,
  meta: Brain,
};

const IMPACT = {
  High: { color: '#10b981', bg: '#ecfdf5', border: 'rgba(16,185,129,0.1)' },
  Medium: { color: '#f59e0b', bg: '#fffbeb', border: 'rgba(245,158,11,0.1)' },
  Low: { color: '#94a3b8', bg: '#f8fafc', border: 'rgba(148,163,184,0.1)' },
};
const EFFORT_COLOR = { Low: '#10b981', Medium: '#f59e0b', High: '#f43f5e' };

export default function RecommendationCard({ title, reason, impact, effort, category }) {
  const cat = CATEGORY[category] || CATEGORY.seo;
  const imp = IMPACT[impact] || IMPACT.Low;
  const Icon = ICONS[category] || Target;
  
  return (
    <div className="flex rounded-2xl border border-slate-200/60 bg-white/70 backdrop-blur-md overflow-hidden transition-all duration-200 hover:border-slate-350 hover:bg-white hover:shadow-sm">
      <div className="w-[3px] shrink-0" style={{ background: imp.color }} />
      <div className="flex items-start gap-3.5 p-4 flex-1 min-w-0">
        <span className="w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0"
          style={{ background: `${cat.color}12`, color: cat.color }}>
          <Icon size={15} strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold text-slate-800 leading-snug">{title}</div>
          <div className="text-[11px] font-semibold text-slate-400 mt-1 leading-relaxed">{reason}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span className="text-[9px] font-black px-2.5 py-0.5 rounded-full border whitespace-nowrap uppercase tracking-wider" 
            style={{ background: imp.bg, borderColor: imp.border, color: imp.color }}>
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
    <span className="text-[9px] font-black px-2.5 py-0.5 rounded-full border whitespace-nowrap uppercase tracking-wider"
      style={{ background: `${color}08`, borderColor: `${color}15`, color }}>
      {label}: {value}
    </span>
  );
}
