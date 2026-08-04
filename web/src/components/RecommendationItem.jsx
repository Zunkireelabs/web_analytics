import { useState } from 'react';
import { api } from '../api.js';

const PRIORITY_STYLE = {
  high: 'bg-rose-50 border-rose-100 text-rose-600',
  medium: 'bg-amber-50 border-amber-100 text-amber-600',
  low: 'bg-slate-50 border-slate-200 text-slate-500',
};

// A single actionable recommendation row. Same generate-on-click execution
// path as ActionCenter.jsx's own Recommendations tab
// (api.actionCenter.generate -> generateDraft -> createDraft) — just a
// simpler, self-contained presentation for embedding elsewhere (e.g.
// GeoAudit.jsx) without depending on ActionCenter's page-level
// master-detail state.
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

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${PRIORITY_STYLE[item.priority] || PRIORITY_STYLE.low}`}>
            {item.priority || 'low'}
          </span>
          {item.params?.page && (
            <span className="text-[10px] text-slate-400 font-mono truncate max-w-[220px]" title={item.params.page}>{item.params.page}</span>
          )}
        </div>
        <p className="text-xs font-bold text-slate-800 mt-1 leading-snug" title={item.tag}>{item.tag}</p>
        {error && <p className="text-[10px] text-rose-600 font-semibold mt-1">{error}</p>}
      </div>
      <button
        type="button"
        onClick={generate}
        disabled={generating}
        className="shrink-0 text-[9px] font-black uppercase tracking-wider py-2 px-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm disabled:opacity-60 cursor-pointer"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
      >
        {generating ? 'Drafting…' : 'Fix'}
      </button>
    </div>
  );
}
