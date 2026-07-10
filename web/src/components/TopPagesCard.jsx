import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

// www vs non-www (or any other host) can share the same path — e.g. "/" for both
// zunkireelabs.com and www.zunkireelabs.com. Plain pathname() would silently
// collapse these into one indistinguishable label, so when a path repeats across
// hosts, fall back to hostname + path for just those rows.
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
    <div className="divide-y divide-slate-50">
      <div className="grid grid-cols-[20px_1fr_64px_52px] gap-2 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        <span></span><span></span>
        <span className="text-right">Impr.</span>
        <span className="text-right">Clicks</span>
      </div>
      {rows.map((r, i) => {
        const impr = num(r.impressions);
        const clicks = num(r.clicks);
        const share = Math.max((impr / max) * 100, 3);
        const rank = i + offset + 1;
        return (
          <div key={i} className="grid grid-cols-[20px_1fr_64px_52px] items-center gap-2 py-2.5">
            <span className="text-[11px] font-semibold text-slate-300 tabular-nums">{rank}</span>
            <div className="min-w-0">
              <span className="text-sm text-slate-700 truncate block" title={r.dim_value}>{labelOf(r.dim_value)}</span>
              <div className="h-1 rounded-full bg-slate-100 overflow-hidden mt-1.5">
                <div className="h-full rounded-full" style={{ width: `${share}%`, background: rank === 1 ? 'linear-gradient(90deg,#6C63FF,#8b5cf6)' : '#c7d2fe' }} />
              </div>
            </div>
            <span className="text-sm font-semibold text-slate-900 text-right tabular-nums">{fmt(impr)}</span>
            <span className="text-sm text-slate-600 text-right tabular-nums">{fmt(clicks)}</span>
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
    <div className="card p-6 flex flex-col">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">Top Pages</h3>
          <p className="text-xs text-slate-400 mt-0.5">Ranked by impressions</p>
        </div>
        {hasMore && (
          <button onClick={() => setShowAll((s) => !s)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 shrink-0">
            {showAll ? 'Show less' : 'View all pages'}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400 animate-pulse">Loading pages…</div>
      ) : rows.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">No page data for this range.</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-x-8 mt-3">
          <Column rows={displayRows.slice(0, mid)} max={max} offset={0} labelOf={labelOf} />
          <Column rows={displayRows.slice(mid)} max={max} offset={mid} labelOf={labelOf} />
        </div>
      )}

      {hasMore && (
        <button onClick={() => setShowAll((s) => !s)}
          className="mt-auto pt-3 border-t border-slate-50 text-sm font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 mx-auto">
          {showAll ? 'Show less' : 'View all pages'} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
