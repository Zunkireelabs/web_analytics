import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

function labelForRows(rows) {
  const pathCounts = {};
  for (const r of rows) pathCounts[pathname(r.dim_value)] = (pathCounts[pathname(r.dim_value)] || 0) + 1;
  return (v) => {
    const p = pathname(v);
    if (pathCounts[p] <= 1) return p;
    try { return `${new URL(v).hostname}${p}`; } catch { return p; }
  };
}

function Column({ rows, max, offset, labelOf }) {
  return (
    <div className="divide-y divide-slate-100/60">
      <div className="grid grid-cols-[24px_1fr_64px_52px] gap-3 pb-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
        <span></span>
        <span>Page Path</span>
        <span className="text-right">Impr.</span>
        <span className="text-right">Clicks</span>
      </div>
      {rows.map((r, i) => {
        const impr = num(r.impressions);
        const clicks = num(r.clicks);
        const share = Math.max((impr / max) * 100, 3);
        const rank = i + offset + 1;
        return (
          <div key={i} className="grid grid-cols-[24px_1fr_64px_52px] items-center gap-3 py-3 hover:bg-slate-50/50 rounded-xl px-1 transition duration-150 group">
            <span className="text-xs font-bold text-slate-300 group-hover:text-slate-400 tabular-nums transition-colors">{rank}</span>
            <div className="min-w-0 pr-2">
              <span className="text-sm font-semibold text-slate-700 truncate block group-hover:text-slate-900 transition-colors" title={r.dim_value}>
                {labelOf(r.dim_value)}
              </span>
              <div className="h-1.5 rounded-full bg-slate-100/80 overflow-hidden mt-2 w-full">
                <div 
                  className="h-full rounded-full transition-all duration-500" 
                  style={{ 
                    width: `${share}%`, 
                    background: rank === 1 
                      ? 'linear-gradient(90deg,#6C63FF,#8b5cf6)' 
                      : 'linear-gradient(90deg,#818cf8,#a7f3d0)' 
                  }} 
                />
              </div>
            </div>
            <span className="text-sm font-bold text-slate-900 text-right tabular-nums">{fmt(impr)}</span>
            <span className="text-sm font-semibold text-slate-600 text-right tabular-nums">{fmt(clicks)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function TopPagesCard({ pages, loading }) {
  const [showAll, setShowAll] = useState(false);
  const rows = [...(pages || [])].sort((a, b) => num(b.impressions) - num(a.impressions));
  const max = Math.max(1, ...rows.map((r) => num(r.impressions)));
  const displayRows = showAll ? rows : rows.slice(0, 10);
  const hasMore = rows.length > 10;
  const mid = Math.ceil(displayRows.length / 2);
  const labelOf = labelForRows(rows);

  return (
    <div className="card p-6 flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">Top Pages</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Most viewed landing pages by organic search impressions</p>
          </div>
          {hasMore && (
            <button onClick={() => setShowAll((s) => !s)} className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition shrink-0">
              {showAll ? 'Show less' : 'View all pages'}
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-slate-400 animate-pulse font-medium">Loading pages…</div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-400 font-medium">No page data for this range.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-x-10 gap-y-6 mt-3">
            <Column rows={displayRows.slice(0, mid)} max={max} offset={0} labelOf={labelOf} />
            <Column rows={displayRows.slice(mid)} max={max} offset={mid} labelOf={labelOf} />
          </div>
        )}
      </div>

      {hasMore && (
        <button onClick={() => setShowAll((s) => !s)}
          className="mt-6 pt-4 border-t border-slate-100 text-xs font-bold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto transition">
          {showAll ? 'Show less' : 'View all pages'} <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
