import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();

export default function TopQueriesCard({ queries, loading }) {
  const [showAll, setShowAll] = useState(false);
  const rows = [...(queries || [])].sort((a, b) => num(b.impressions) - num(a.impressions));
  const max = Math.max(1, ...rows.map((r) => num(r.impressions)));
  const displayRows = showAll ? rows : rows.slice(0, 6);
  const hasMore = rows.length > 6;

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">Top Queries</h3>
          <p className="text-xs text-slate-400 mt-0.5">Ranked by impressions</p>
        </div>
        {hasMore && (
          <button onClick={() => setShowAll((s) => !s)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 shrink-0">
            {showAll ? 'Show less' : 'View all queries'}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400 animate-pulse">Loading queries…</div>
      ) : rows.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">No query data for this range.</div>
      ) : (
        <>
          <div className="grid grid-cols-[24px_1fr_84px_64px_64px] gap-2 px-1 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span>#</span><span>Query</span>
            <span className="text-right">Impressions</span>
            <span className="text-right">Clicks</span>
            <span className="text-right">CTR</span>
          </div>
          <div className="divide-y divide-slate-50">
            {displayRows.map((r, i) => {
              const impr = num(r.impressions);
              const clicks = num(r.clicks);
              const ctr = impr > 0 ? (clicks / impr) * 100 : 0;
              const share = Math.max((impr / max) * 100, 3);
              return (
                <div key={i} className="grid grid-cols-[24px_1fr_84px_64px_64px] items-center gap-2 py-3 px-1">
                  <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
                    style={i === 0 ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' } : { background: '#f1f5f9', color: '#94a3b8' }}>
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-slate-700 truncate" title={r.dim_value}>{r.dim_value}</span>
                      {i === 0 && (
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">Top</span>
                      )}
                    </div>
                    <div className="h-1 rounded-full bg-slate-100 overflow-hidden mt-1.5">
                      <div className="h-full rounded-full bg-indigo-500" style={{ width: `${share}%` }} />
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-slate-900 text-right tabular-nums">{fmt(impr)}</span>
                  <span className="text-sm text-slate-600 text-right tabular-nums">{fmt(clicks)}</span>
                  <span className="text-sm text-slate-600 text-right tabular-nums">{ctr.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {hasMore && (
        <button onClick={() => setShowAll((s) => !s)}
          className="mt-auto pt-3 border-t border-slate-50 text-sm font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto">
          {showAll ? 'Show less' : 'View all queries'} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
