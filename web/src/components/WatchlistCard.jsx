import { timeAgo } from '../api.js';
import { Target, Globe, FileText, BrainCircuit, Play, Check, X, TrendingUp, Sparkles } from 'lucide-react';

export const PRIORITY = {
  high: { color: '#e11d48', label: 'High Priority', bg: '#fff1f2', text: '#e11d48' },
  medium: { color: '#f59e0b', label: 'Medium Priority', bg: '#fffbeb', text: '#d97706' },
  low: { color: '#64748b', label: 'Info', bg: '#f8fafc', text: '#64748b' },
};

const STATUS = {
  new: { label: 'New', color: '#6C63FF', bg: '#f5f3ff', text: '#6C63FF' },
  in_progress: { label: 'In Progress', color: '#d97706', bg: '#fffbeb', text: '#b45309' },
};

const CATEGORY_META = {
  seo: { label: 'SEO', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Audience', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Overview', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' }
};

export default function WatchlistCard({ item, generating, onGenerate, onStatusChange }) {
  const catKey = item.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const pr = PRIORITY[item.priority] || PRIORITY.low;
  const status = STATUS[item.status] || STATUS.new;
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm shadow-slate-100/60 hover:shadow-md hover:border-slate-350 transition-all duration-300 flex flex-col h-full relative overflow-hidden text-slate-700">
      <div className="absolute left-0 inset-y-0 w-1" style={{ backgroundColor: pr.color }} />

      <div className="p-4 flex flex-col gap-2.5 flex-1 min-w-0 pl-5">
        <div className="flex items-start gap-2.5">
          <span className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm bg-white" style={{ color: cat.color }}>
            <IconComponent size={13} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">{cat.label} · {pr.label}</span>
              <span className="text-[9px] font-black uppercase tracking-wider shrink-0" style={{ color: status.text }}>{status.label}</span>
            </div>
            <h4 className="text-xs font-extrabold text-slate-900 leading-snug mt-1">{item.title}</h4>
            <p className="text-[10.5px] font-semibold text-slate-505 leading-relaxed mt-1 break-words">{item.reason}</p>
          </div>
        </div>

        {(item.expectedImpact?.label || item.confidence != null) && (
          <div className="flex items-center gap-3 flex-wrap text-[10px] font-bold text-slate-500 pl-[42px]">
            {item.expectedImpact?.label && (
              <span className="inline-flex items-center gap-1">
                <TrendingUp size={11} className="text-slate-400" />
                {item.expectedImpact.label} impact{item.expectedImpact.basis === 'estimate' ? ' (estimate)' : ''}
              </span>
            )}
            {item.confidence != null && (
              <span className="inline-flex items-center gap-1">
                <Sparkles size={11} className="text-slate-400" />
                {Math.round(item.confidence * 100)}% AI confidence
              </span>
            )}
          </div>
        )}

        {item.reopened && (
          <div className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl px-2.5 py-1.5 leading-relaxed">
            ↺ Reopened {timeAgo(item.reopened.at)} — {item.reopened.reason}
          </div>
        )}

        <div className="flex items-center flex-wrap gap-1.5 mt-auto pt-2.5 border-t border-slate-100">
          {item.recommendedAction?.generatorId && (
            <button
              type="button"
              onClick={() => onGenerate(item)}
              disabled={generating}
              className="text-[10px] font-black uppercase tracking-wider px-3.5 py-2 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/20 cursor-pointer max-w-[160px] sm:max-w-[220px] truncate"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              {generating ? 'Generating Fix…' : 'Generate Fix →'}
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
      </div>
    </div>
  );
}
