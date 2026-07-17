import { timeAgo } from '../api.js';
import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit, 
  Activity,
  CheckCircle2,
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
    <div className="relative pl-6 space-y-4">
      {/* Vertical Timeline Bar */}
      <div className="absolute left-[13px] top-2 bottom-2 w-[1.5px] bg-slate-100/80" />

      {items.map((a, i) => {
        const attempted = a.status !== 'ok';
        const catKey = a.category || 'seo';
        const cat = CATEGORY_META[catKey] || { label: 'Audit', icon: Activity, color: '#64748b', bgLight: '#f8fafc' };
        const IconComponent = cat.icon;

        return (
          <div key={i} className="relative flex items-start gap-3.5 group">
            {/* Timeline Dot Indicator */}
            <span 
              className="w-7 h-7 rounded-full grid place-items-center shrink-0 border z-10 bg-white transition shadow-sm group-hover:scale-105"
              style={attempted ? { borderColor: '#e2e8f0', color: '#94a3b8' } : { borderColor: `${cat.color}2b`, color: cat.color }}
            >
              <IconComponent size={11} strokeWidth={2.5} />
            </span>

            {/* Content card info */}
            <div className="flex-1 min-w-0 bg-slate-50/40 border border-slate-100 rounded-2xl p-2.5 hover:bg-slate-50 transition">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span 
                  className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border"
                  style={attempted ? { color: '#64748b', backgroundColor: '#f1f5f9', borderColor: '#e2e8f0' } : { color: cat.color, backgroundColor: cat.bgLight, borderColor: `${cat.color}1e` }}
                >
                  {attempted ? 'Attempted' : cat.label}
                </span>
                
                <span className="text-[10px] text-slate-400 font-mono font-medium">
                  {timeAgo(a.createdAt)}
                </span>
              </div>

              <p className={`text-[11px] font-semibold leading-relaxed ${attempted ? 'text-slate-400 italic' : 'text-slate-650'}`}>
                {attempted ? `Failed: ${a.label}` : a.label}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
