import { useState, useEffect } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import { 
  Target, 
  Globe, 
  FileText, 
  Brain, 
  ArrowRight, 
  Cpu, 
  CheckCircle2, 
  HelpCircle,
  FileSearch,
  Check
} from 'lucide-react';

const ICONS = {
  seo: Target,
  geo: Globe,
  content: FileText,
  meta: Brain,
};

export default function AgentFindingsHub({ findings = [] }) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [animate, setAnimate] = useState(false);

  // Trigger brief fade animation on selection change
  useEffect(() => {
    setAnimate(true);
    const t = setTimeout(() => setAnimate(false), 200);
    return () => clearTimeout(t);
  }, [selectedIdx]);

  if (!findings || findings.length === 0) return null;

  const current = findings[selectedIdx] || findings[0];
  const cat = CATEGORY[current.category] || CATEGORY.seo;
  const ActiveIcon = ICONS[current.category] || Target;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      {/* Left Navigation: List of findings/agents */}
      <div className="lg:col-span-4 flex flex-col gap-2.5 max-h-[480px] overflow-y-auto pr-1 custom-scrollbar">
        {findings.map((f, i) => {
          const itemCat = CATEGORY[f.category] || CATEGORY.seo;
          const ItemIcon = ICONS[f.category] || Target;
          const isSelected = i === selectedIdx;

          return (
            <button
              key={f.agentId || f.name || i}
              onClick={() => setSelectedIdx(i)}
              className={`text-left p-3.5 rounded-2xl border transition-all duration-200 flex items-center justify-between gap-3 group ${
                isSelected 
                  ? 'bg-white border-slate-300 shadow-md ring-1 ring-slate-100' 
                  : 'bg-white/50 border-slate-200/60 hover:bg-white hover:border-slate-300 hover:shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span 
                  className={`w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0 transition-transform duration-350 ${
                    isSelected ? 'scale-105' : 'group-hover:scale-105'
                  }`}
                  style={{ 
                    background: isSelected ? `${itemCat.color}16` : '#f8fafc', 
                    color: isSelected ? itemCat.color : '#94a3b8' 
                  }}
                >
                  <ItemIcon size={15} strokeWidth={2.5} />
                </span>
                <div className="min-w-0">
                  <span className="text-[9px] font-black uppercase tracking-wider block" style={{ color: itemCat.color }}>
                    {itemCat.label}
                  </span>
                  <span className="text-xs font-bold text-slate-800 truncate block mt-0.5" title={f.name}>
                    {f.name}
                  </span>
                </div>
              </div>

              {f.stat && (
                <span 
                  className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full border shrink-0 transition-colors ${
                    isSelected 
                      ? 'border-indigo-500/20 text-indigo-600 bg-indigo-500/5' 
                      : 'border-slate-200/50 bg-slate-100/50 text-slate-400'
                  }`}
                  style={isSelected ? { borderColor: `${itemCat.color}20`, color: itemCat.color, background: `${itemCat.color}08` } : {}}
                >
                  {f.stat}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right Content: Expanded visual details */}
      <div className="lg:col-span-8 card p-6 bg-white/80 backdrop-blur-md flex flex-col justify-between relative overflow-hidden min-h-[350px]">
        {/* Accent Glow Line */}
        <div className="absolute top-0 inset-x-0 h-[4px]" style={{ background: `linear-gradient(90deg, ${cat.color}, ${cat.color}22)` }} />
        
        <div className={`transition-opacity duration-200 ${animate ? 'opacity-30' : 'opacity-100'}`}>
          {/* Header row */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-150 pb-4">
            <div className="flex items-center gap-3">
              <span 
                className="w-10 h-10 rounded-2xl grid place-items-center text-white shadow-md shadow-indigo-500/10"
                style={{ background: `linear-gradient(135deg, ${cat.color}, ${cat.color}bb)` }}
              >
                <ActiveIcon size={18} strokeWidth={2.25} />
              </span>
              <div className="leading-tight">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 block">Agent Audit Report</span>
                <span className="text-sm font-extrabold text-slate-950 block mt-0.5">{current.name}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/15">
                <Cpu size={10} className="animate-pulse" /> Active Analysis
              </span>
            </div>
          </div>

          {/* Main finding callout box */}
          <div className="mt-5 p-4 rounded-2xl border bg-slate-50/40 border-slate-200/50" style={{ borderLeftWidth: 4, borderLeftColor: cat.color }}>
            <span className="text-[9px] font-black uppercase tracking-wider block" style={{ color: cat.color }}>Steepest Trend Finding</span>
            <blockquote className="text-sm font-bold text-slate-800 leading-relaxed mt-1 break-words">
              “{current.headline}”
            </blockquote>
          </div>

          {/* Detailed Narrative bullet point list */}
          <div className="mt-5">
            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Diagnostic Breakdown</h4>
            <div className="text-xs font-semibold text-slate-600 leading-relaxed space-y-3 break-words pr-2">
              {current.narrative ? (
                current.narrative.split('\n').filter(Boolean).map((para, pIdx) => (
                  <p key={pIdx} className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-2 shrink-0" />
                    <span>{para}</span>
                  </p>
                ))
              ) : (
                <p>No further diagnostic text was logged for this agent.</p>
              )}
            </div>
          </div>
        </div>

        {/* Footer/Action links */}
        <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1.5">
            <Check size={12} className="text-emerald-500" /> Auto-audited via {cat.label} engine
          </span>

          <a
            href="#recommendations-section"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('recommendations-section')?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="text-[10px] font-black uppercase tracking-wider hover:underline transition-colors flex items-center gap-1"
            style={{ color: cat.color }}
          >
            Go to Action Plans <ArrowRight size={12} strokeWidth={2.5} />
          </a>
        </div>
      </div>
    </div>
  );
}
