import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit,
  TrendingUp,
  CheckCircle2
} from 'lucide-react';

const CATEGORY_META = {
  seo: { label: 'SEO & Tech', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Geo Target', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content Audit', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Executive Brief', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' }
};

export default function OpportunityCard({ finding }) {
  const catKey = finding.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200/50 bg-gradient-to-br from-white to-slate-50/40 p-4 transition-all duration-300 hover:shadow-md hover:border-slate-350 relative group overflow-hidden flex flex-col justify-between shadow-sm">
      {/* Accent Indicator Bar */}
      <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-emerald-500 to-emerald-300" />
      
      <div>
        {/* Row 1: Badges & Tags */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span 
              className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border"
              style={{ color: cat.color, backgroundColor: cat.bgLight, borderColor: cat.borderLight }}
            >
              {cat.label}
            </span>
            <span className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700 flex items-center gap-0.5">
              <TrendingUp size={8} /> Growth Target
            </span>
            {finding.expectedImpact?.basis === 'estimate' && (
              <span className="text-[9px] font-bold text-slate-400 border border-slate-150 rounded-full px-2 py-0.5 bg-slate-50/50">
                Estimated Impact
              </span>
            )}
          </div>
          <span className="text-emerald-555 text-[10px] flex items-center gap-0.5 font-bold">
            <CheckCircle2 size={10} /> Active
          </span>
        </div>

        {/* Row 2: Headline & Description */}
        <div className="flex items-start gap-3">
          <span 
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm"
            style={{ backgroundColor: `${cat.color}0c`, color: cat.color, borderColor: `${cat.color}1e` }}
          >
            <IconComponent size={14} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13px] font-extrabold text-slate-900 leading-snug group-hover:text-indigo-650 transition-colors">
              {finding.recommendedAction?.label || finding.agentName || 'Growth Target'}
            </h4>
            <p className="text-[11px] font-semibold text-slate-505 leading-relaxed mt-2.5 break-words bg-slate-50 p-2.5 rounded-xl border border-slate-150 shadow-inner">
              {finding.whyItMatters}
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}
