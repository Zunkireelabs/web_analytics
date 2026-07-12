const fmtInt = (v) => Number(v).toLocaleString();

// Compact scannable list of recent same-period snapshots — metrics only,
// since narrative is only ever persisted for the current period.
export default function ReportHistoryRail({ history = [] }) {
  return (
    <div className="card p-4 h-full">
      <h3 className="text-[13px] font-semibold text-slate-700 mb-3">Recent Report History</h3>
      <div className="space-y-1">
        {history.length === 0 && <div className="text-xs text-slate-400 py-3 text-center">No history yet.</div>}
        {history.map((h, i) => (
          <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-50 transition">
            <span className="text-xs text-slate-600 truncate">{h.label}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs font-semibold text-slate-800">{fmtInt(h.clicks)}</span>
              {h.deltaPct != null && (
                <span className={`text-[10px] font-semibold ${h.deltaPct >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                  {h.deltaPct >= 0 ? '▲' : '▼'} {Math.abs(h.deltaPct)}%
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
