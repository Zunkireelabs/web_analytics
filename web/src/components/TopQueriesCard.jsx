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
    <div className="card p-6 flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">Top Queries</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Ranked by search impressions</p>
          </div>
          {hasMore && (
            <button onClick={() => setShowAll((s) => !s)}
              className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition shrink-0">
              {showAll ? 'Show less' : 'View all queries'}
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-slate-400 animate-pulse font-medium">Loading queries…</div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-400 font-medium">No query data for this range.</div>
        ) : (
          <>
            <div className="grid grid-cols-[28px_1fr_84px_64px_64px] gap-3 px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <span>#</span>
              <span>Query</span>
              <span className="text-right">Impressions</span>
              <span className="text-right">Clicks</span>
              <span className="text-right">CTR</span>
            </div>
            <div className="divide-y divide-slate-100/50">
              {displayRows.map((r, i) => {
                const impr = num(r.impressions);
                const clicks = num(r.clicks);
                const ctr = impr > 0 ? (clicks / impr) * 100 : 0;
                const share = Math.max((impr / max) * 100, 3);
                return (
                  <div key={i} className="grid grid-cols-[28px_1fr_84px_64px_64px] items-center gap-3 py-3 px-2 hover:bg-slate-50/50 rounded-xl transition duration-150 group">
                    <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-extrabold shrink-0"
                      style={i === 0 
                        ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff', boxShadow: '0 4px 8px -2px rgba(108, 99, 255, 0.3)' } 
                        : { background: '#f1f5f9', color: '#64748b' }}>
                      {i + 1}
                    </span>
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-slate-700 truncate group-hover:text-slate-900 transition-colors" title={r.dim_value}>
                          {r.dim_value}
                        </span>
                        {i === 0 && (
                          <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">Top</span>
                        )}
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100/80 overflow-hidden mt-2 w-full">
                        <div className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-[#6C63FF] to-[#8b5cf6]" style={{ width: `${share}%` }} />
                      </div>
                    </div>
                    <span className="text-sm font-bold text-slate-900 text-right tabular-nums">{fmt(impr)}</span>
                    <span className="text-sm font-medium text-slate-600 text-right tabular-nums">{fmt(clicks)}</span>
                    <span className="text-sm font-semibold text-slate-700 text-right tabular-nums">{ctr.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {hasMore && (
        <button onClick={() => setShowAll((s) => !s)}
          className="mt-4 pt-4 border-t border-slate-100 text-xs font-bold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto transition">
          {showAll ? 'Show less' : 'View all queries'} <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
