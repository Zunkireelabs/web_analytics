import { timeAgo } from '../api.js';
import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit, 
  Activity,
  AlertCircle
} from 'lucide-react';

const CATEGORY_META = {
  seo: { label: 'SEO Audit', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c' },
  geo: { label: 'Geo Target', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c' },
  content: { label: 'Content Strategy', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c' },
  meta: { label: 'Executive Brain', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c' }
};

export default function ActivityFeed({ items }) {
  if (!items?.length) {
    return <div className="card p-6 text-center text-xs font-semibold text-slate-400">No activity logged yet.</div>;
  }

  return (
    <div className="relative pl-10 pr-4 space-y-4">
      {/* Vertical Timeline Bar */}
      <div className="absolute left-[8px] top-2 bottom-2 w-[1.5px] bg-indigo-100/40" />

      {items.map((a, i) => {
        const attempted = a.status !== 'ok';
        const catKey = a.category || 'seo';
        const cat = CATEGORY_META[catKey] || { label: 'Audit', icon: Activity, color: '#64748b', bgLight: '#f8fafc' };
        const IconComponent = cat.icon;

        return (
          <div key={i} className="relative group min-h-[64px]">
            {/* Timeline Dot Indicator */}
            <span 
              className="absolute left-[-32px] top-[22px] -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full grid place-items-center border z-10 bg-white transition-all duration-300 shadow-sm group-hover:scale-110 group-hover:shadow-md"
              style={attempted ? { borderColor: '#e2e8f0', color: '#94a3b8' } : { borderColor: `${cat.color}44`, color: cat.color, boxShadow: `0 0 10px ${cat.color}15` }}
            >
              <IconComponent size={11} strokeWidth={2.5} />
            </span>

            {/* Content card info */}
            <div className="bg-gradient-to-br from-white to-slate-50/50 border border-slate-200/80 rounded-2xl p-3 hover:-translate-y-0.5 hover:shadow-md hover:bg-white hover:border-slate-300 transition-all duration-300 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span 
                  className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border shadow-sm"
                  style={attempted ? { color: '#64748b', backgroundColor: '#f1f5f9', borderColor: '#e2e8f0' } : { color: cat.color, backgroundColor: cat.bgLight, borderColor: `${cat.color}25` }}
                >
                  {attempted ? 'Attempted' : cat.label}
                </span>
                
                <span className="text-[10px] text-slate-400 font-mono font-bold">
                  {timeAgo(a.createdAt)}
                </span>
              </div>

              <p className={`text-[11.5px] font-semibold leading-relaxed ${attempted ? 'text-slate-400 italic' : 'text-slate-700'}`}>
                {attempted ? (
                  <span className="flex items-center gap-1">
                    <AlertCircle size={10} className="text-rose-500 shrink-0" />
                    <span>Failed: {a.label}</span>
                  </span>
                ) : a.label}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
