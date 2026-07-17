import { useState } from 'react';
import { timeAgo } from '../api.js';
import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit, 
  ChevronDown, 
  ChevronUp, 
  Play, 
  Check, 
  X,
  PlusCircle,
  TrendingUp,
  Settings
} from 'lucide-react';

export const PRIORITY = {
  high: { color: '#e11d48', label: 'High Priority', bg: '#fff1f2', text: '#e11d48' },
  medium: { color: '#f59e0b', label: 'Medium Priority', bg: '#fffbeb', text: '#d97706' },
  low: { color: '#64748b', label: 'Info', bg: '#f8fafc', text: '#64748b' },
};

const STATUS = {
  new: { label: 'New', color: '#6C63FF', bg: '#f5f3ff', text: '#6C63FF' },
  in_progress: { label: 'In Progress', color: '#d97706', bg: '#fffbeb', text: '#b45309' },
};

const EVIDENCE_LABEL = {
  page: 'Page Route', impressions: 'Impressions Count', clicks: 'Clicks Count', avgPosition: 'Avg. Position',
  score: 'Audit Score', country: 'Country', city: 'City', device: 'Target Device', query: 'Search Query',
  language: 'Target Language', recent: 'Recent Clicks', prior: 'Prior Clicks', delta: 'Change Delta',
};

const CATEGORY_META = {
  seo: { label: 'SEO & Tech', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Geo Target', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content Strategy', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Executive Brain', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' }
};

export default function WatchlistCard({ item, generating, onGenerate, onStatusChange }) {
  const [expanded, setExpanded] = useState(false);
  const catKey = item.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const pr = PRIORITY[item.priority] || PRIORITY.low;
  const status = STATUS[item.status] || STATUS.new;
  const evidenceEntries = Object.entries(item.evidence || {}).filter(([, v]) => v != null && v !== '');
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm shadow-slate-100/60 hover:shadow-md hover:border-slate-350 transition-all duration-300 flex flex-col h-full relative overflow-hidden text-slate-700">
      {/* Decorative vertical colored stripe */}
      <div className="absolute left-0 inset-y-0 w-1" style={{ backgroundColor: pr.color }} />

      <div className="p-3.5 flex flex-col gap-2.5 flex-1 min-w-0 pl-4.5">
        
        {/* Row 1: Badges Header */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span 
              className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border"
              style={{ color: cat.color, backgroundColor: cat.bgLight, borderColor: cat.borderLight }}
            >
              {cat.label}
            </span>
            <span 
              className="text-[9px] font-extrabold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: pr.bg, color: pr.text }}
            >
              {pr.label}
            </span>
            {item.agentName && (
              <span className="text-[9px] font-bold text-slate-400">
                · {item.agentName}
              </span>
            )}
          </div>

          <span 
            className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ml-auto"
            style={{ color: status.text, backgroundColor: status.bg, borderColor: `${status.color}1e` }}
          >
            {status.label}
          </span>
        </div>

        {/* Row 2: Headline & Description */}
        <div className="flex items-start gap-2.5">
          <span 
            className="w-7 h-7 rounded-xl grid place-items-center shrink-0 border shadow-sm bg-white"
            style={{ color: cat.color }}
          >
            <IconComponent size={12} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-extrabold text-slate-900 leading-snug">
              {item.title}
            </h4>
            <p className="text-[10px] font-semibold text-slate-505 leading-relaxed mt-0.5 break-words">
              {item.reason}
            </p>
          </div>
        </div>
        {/* Collapsible Details & Actions Drawer */}
        {!expanded ? (
          <button 
            type="button" 
            onClick={() => setExpanded(true)}
            className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/85 hover:text-[#6C63FF] hover:underline mt-1 self-start flex items-center gap-1 py-2 focus:outline-none cursor-pointer"
          >
            Show details & actions <ChevronDown size={10} />
          </button>
        ) : (
          <div className="flex flex-col gap-3 pt-2.5 border-t border-slate-100/50 mt-1 animate-slide-down">
            {/* Row 3: Reopen indicator */}
            {item.reopened && (
              <div className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl px-2.5 py-1.5 leading-relaxed">
                ↺ Reopened {timeAgo(item.reopened.at)} — {item.reopened.reason}
              </div>
            )}

            {/* Row 4: Impact & Discovery Stats */}
            <div className="flex items-center justify-between gap-3 text-[9px] text-slate-400 font-semibold pt-0.5">
              {item.expectedImpact?.label && (
                <span className="flex items-center gap-1">
                  <TrendingUp size={10} className="text-slate-350" />
                  <span>{item.expectedImpact.label} impact{item.expectedImpact.basis === 'estimate' ? ' (estimate)' : ''}</span>
                </span>
              )}
              <span className="font-mono text-[9px] text-slate-400">
                Added {timeAgo(item.discoveredAt)}
              </span>
            </div>

            {/* Row 5: Evidence table */}
            {evidenceEntries.length > 0 && (
              <div className="bg-slate-950/85 border border-slate-800 rounded-2xl p-2.5 space-y-1 shadow-inner">
                <div className="text-[8px] font-black uppercase tracking-widest text-[#8b5cf6] pb-1 border-b border-slate-800/80 mb-1">Watchlist Diagnostics</div>
                {evidenceEntries.map(([k, v]) => (
                  <div key={k} className="flex justify-between items-center text-[9px] font-mono leading-tight">
                    <span className="text-slate-500">{EVIDENCE_LABEL[k] || k}</span>
                    <span className="text-slate-350 font-bold max-w-[150px] truncate text-right">
                      {String(v)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Row 6: Action Trigger Buttons */}
            <div className="flex items-center flex-wrap gap-1.5 pt-2.5 border-t border-slate-100">
              {item.recommendedAction?.generatorId && (
                <button
                  type="button"
                  onClick={() => onGenerate(item)}
                  disabled={generating}
                  className="text-[9px] font-black uppercase tracking-wider px-3 py-1.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/15 cursor-pointer max-w-[140px] sm:max-w-[200px] truncate"
                  style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                >
                  {generating ? 'Drafting…' : `Fix: ${item.recommendedAction.label}`}
                </button>
              )}

              {item.status === 'new' && (
                <button 
                  type="button" 
                  onClick={() => onStatusChange(item.id, 'in_progress')}
                  className="text-[9px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-xl text-slate-650 bg-slate-100 hover:bg-slate-200 transition flex items-center gap-1 cursor-pointer"
                >
                  <Play size={10} fill="currentColor" className="text-slate-400" /> Start
                </button>
              )}

              {item.status === 'in_progress' && (
                <button 
                  type="button" 
                  onClick={() => onStatusChange(item.id, 'completed')}
                  className="text-[9px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-xl text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 transition flex items-center gap-1 cursor-pointer"
                >
                  <Check size={10} strokeWidth={3} /> Mark Done
                </button>
              )}

              <button 
                type="button" 
                onClick={() => onStatusChange(item.id, 'no_longer_applicable')}
                className="text-[9px] font-black uppercase tracking-wider px-3 py-1.5 rounded-xl text-slate-405 hover:text-slate-600 hover:bg-slate-50 transition ml-auto flex items-center gap-0.5 cursor-pointer"
              >
                <X size={10} /> Dismiss
              </button>
            </div>

            {/* Collapse toggle */}
            <button 
              type="button" 
              onClick={() => setExpanded(false)}
              className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/85 hover:text-[#6C63FF] hover:underline mt-1 self-start flex items-center gap-1 py-2 focus:outline-none cursor-pointer"
            >
              Hide details <ChevronUp size={10} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
