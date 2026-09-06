import { useState } from 'react';
import { api } from '../api.js';
import { Sparkles, ArrowRight, ExternalLink, RefreshCw, AlertCircle, Zap } from 'lucide-react';

const PRIORITY_META = {
  high: { label: 'High Priority', style: 'bg-rose-50 border-rose-200 text-rose-700' },
  medium: { label: 'Medium Priority', style: 'bg-amber-50 border-amber-200 text-amber-700' },
  low: { label: 'Low Priority', style: 'bg-slate-100 border-slate-200 text-slate-600' },
};

export default function RecommendationItem({ item, onGenerated }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(item.generatorId, item.params, item.source, item.id);
      onGenerated?.(draft);
    } catch (e) {
      setError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const priorityInfo = PRIORITY_META[item.priority] || PRIORITY_META.low;

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-2xs hover:border-indigo-300 hover:shadow-xs transition group flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-md border ${priorityInfo.style}`}>
            {item.priority || 'low'}
          </span>

          {item.params?.page && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 font-mono bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md truncate max-w-[280px]" title={item.params.page}>
              <ExternalLink size={10} className="shrink-0 text-slate-400" />
              <span className="truncate">{item.params.page}</span>
            </span>
          )}
        </div>

        <p className="text-xs sm:text-sm font-bold text-slate-800 leading-snug group-hover:text-indigo-950 transition" title={item.tag}>
          {item.tag}
        </p>

        {error && (
          <p className="text-[10px] text-rose-600 font-semibold flex items-center gap-1">
            <AlertCircle size={11} /> {error}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={generate}
        disabled={generating}
        className="shrink-0 flex items-center justify-center gap-1.5 text-[10px] font-black uppercase tracking-wider py-2.5 px-4 rounded-xl text-white transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs disabled:opacity-60 cursor-pointer"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
      >
        <Sparkles size={12} className={generating ? 'animate-spin' : ''} />
        <span>{generating ? 'Drafting Fix...' : 'Fix with AI'}</span>
      </button>
    </div>
  );
}
