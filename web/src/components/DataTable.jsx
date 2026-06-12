// Visual ranked list (queries / pages): rank badge, gradient magnitude bar,
// headline clicks, and impressions + position as chips — not a plain table.
export default function DataTable({ title, rows, labelKey = 'dim_value', labelFormat = (v) => v }) {
  const list = rows || [];
  const maxImpr = Math.max(1, ...list.map((r) => Number(r.impressions) || 0));

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="card-title">{title}</div>
        <span className="text-[10px] text-slate-400 bg-slate-50 rounded-full px-2 py-0.5">Top {list.length || 0}</span>
      </div>

      {list.length === 0 && <div className="text-sm text-slate-400 py-4">No data.</div>}

      <div className="divide-y divide-slate-50">
        {list.map((r, i) => {
          const clicks = Number(r.clicks) || 0;
          const impr = Number(r.impressions) || 0;
          const pos = Number(r.position) || 0;
          return (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <RankBadge n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-700 truncate" title={r[labelKey]}>{labelFormat(r[labelKey])}</span>
                  <span className="text-sm font-bold text-slate-900 shrink-0">{clicks.toLocaleString()}<span className="text-[10px] font-normal text-slate-400"> clk</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 mt-1.5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(impr / maxImpr) * 100}%`, background: 'linear-gradient(90deg,#6C63FF,#8b5cf6)' }} />
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[11px]">
                  <span className="text-slate-400">👁 {impr.toLocaleString()} impr</span>
                  <PosPill pos={pos} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RankBadge({ n }) {
  const top = n <= 3;
  return (
    <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
      style={top
        ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' }
        : { background: '#f1f5f9', color: '#94a3b8' }}>
      {n}
    </span>
  );
}

// Lower Search position = better → green; mid → amber; high → rose.
function PosPill({ pos }) {
  if (!pos) return null;
  const s = pos <= 10
    ? { background: 'rgba(16,185,129,0.1)', color: '#059669' }
    : pos <= 20
      ? { background: 'rgba(245,158,11,0.12)', color: '#b45309' }
      : { background: 'rgba(244,63,94,0.1)', color: '#e11d48' };
  return <span className="px-1.5 py-0.5 rounded-md font-medium" style={s}>#{pos.toFixed(1)}</span>;
}
