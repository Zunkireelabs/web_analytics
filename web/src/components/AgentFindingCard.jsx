import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import { Target, Globe, FileText, Brain, ChevronDown, ChevronUp } from 'lucide-react';

const ICONS = {
  seo: Target,
  geo: Globe,
  content: FileText,
  meta: Brain,
};

export default function AgentFindingCard({ category, name, stat, headline, narrative }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[category] || CATEGORY.seo;
  const Icon = ICONS[category] || Target;
  const hasMore = narrative && narrative !== headline;

  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white/75 backdrop-blur-md overflow-hidden transition-all duration-300 hover:scale-[1.01] hover:bg-white hover:shadow-lg flex flex-col group">
      <div className="h-[3px] shrink-0" style={{ background: `linear-gradient(90deg, ${cat.color}, ${cat.color}33)` }} />
      <div className="p-4 flex flex-col flex-1 justify-between">
        
        {/* Header section with icon, label and stat badge */}
        <div>
          <div className="flex items-center justify-between gap-2 border-b border-slate-100/60 pb-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span 
                className="w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0 transition-transform duration-300 group-hover:scale-105"
                style={{ background: `${cat.color}12`, color: cat.color }}
              >
                <Icon size={15} strokeWidth={2.5} />
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-wider" style={{ color: cat.color }}>{cat.label}</div>
                <div className="text-[9px] font-bold text-slate-400 truncate mt-0.5">{name}</div>
              </div>
            </div>
            {stat && (
              <span 
                className="text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border shrink-0"
                style={{ background: `${cat.color}08`, borderColor: `${cat.color}20`, color: cat.color }}
              >
                {stat}
              </span>
            )}
          </div>
          
          {/* Main finding headline */}
          <p className="text-xs font-bold text-slate-800 mt-4 leading-relaxed break-words">{headline}</p>
        </div>

        {/* Narrative details drawer */}
        {hasMore && (
          <div className="mt-4 pt-3 border-t border-slate-100/60">
            <button 
              type="button" 
              onClick={() => setExpanded((e) => !e)}
              className="text-[10px] font-black hover:underline transition-colors flex items-center gap-1 uppercase tracking-wider"
              style={{ color: cat.color }}
            >
              {expanded ? 'Hide Details' : 'View Details'}
              {expanded ? <ChevronUp size={11} strokeWidth={3} /> : <ChevronDown size={11} strokeWidth={3} />}
            </button>
            {expanded && (
              <div 
                className="mt-2.5 p-3 rounded-xl border text-[11px] text-slate-500 leading-relaxed break-words bg-slate-50/50 border-slate-100 transition-all duration-200" 
                style={{ borderLeftColor: cat.color, borderLeftWidth: 3 }}
              >
                {narrative}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
