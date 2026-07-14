const fmtInt = (v) => Number(v).toLocaleString();

// Same day, one week ago and one week before that both fall on the same
// weekday — useful context a bare date doesn't give at a glance.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `history[].label` has a different real shape per report period (server/
// routes/metrics.js): daily is a plain "YYYY-MM-DD", weekly is a range
// "YYYY-MM-DD – YYYY-MM-DD", monthly is "YYYY-MM". Parsing a range or
// bare-month string as if it were a single YMD date used to silently
// produce "Invalid Date" on the Weekly tab — this handles all three shapes.
function friendlyDate(label) {
  const rangeMatch = /^(\d{4}-\d{2}-\d{2})\s*–\s*(\d{4}-\d{2}-\d{2})$/.exec(label || '');
  if (rangeMatch) {
    const d = new Date(`${rangeMatch[1]}T00:00:00Z`);
    const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    return { weekday: 'Week of', day: `${month} ${d.getUTCDate()}` };
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(label || '');
  if (monthMatch) {
    const d = new Date(`${label}-01T00:00:00Z`);
    return { weekday: d.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'UTC' }), day: d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) };
  }
  const d = new Date(`${label}T00:00:00Z`);
  const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return { weekday: WEEKDAY[d.getUTCDay()], day: `${month} ${d.getUTCDate()}` };
}

// Compact scannable list of recent same-period snapshots — metrics only,
// since narrative is only ever persisted for the current period. Each row's
// magnitude bar (relative to the busiest day shown) makes the trend
// readable at a glance instead of requiring a read of every number; same
// rank-bar language TopQueriesCard already uses elsewhere in this app.
export default function ReportHistoryRail({ history = [] }) {
  const max = Math.max(1, ...history.map((h) => Number(h.clicks) || 0));

  return (
    <div className="card p-5 h-full flex flex-col">
      <h3 className="text-[13px] font-semibold text-slate-700 mb-3">Recent Report History</h3>
      {history.length === 0 ? (
        <div className="text-xs text-slate-400 py-10 text-center flex-1 grid place-items-center">No history yet.</div>
      ) : (
        <div className="space-y-1 -mx-1">
          {history.map((h, i) => {
            const clicks = Number(h.clicks) || 0;
            const share = Math.max((clicks / max) * 100, 4);
            const { weekday, day } = friendlyDate(h.label);
            const isLatest = i === 0;
            return (
              <div key={h.label}
                className={`flex items-center gap-3 px-2.5 py-2 rounded-xl transition ${isLatest ? 'bg-indigo-50/60' : 'hover:bg-slate-50'}`}>
                <div className="w-11 shrink-0 leading-tight">
                  <div className={`text-[10px] font-semibold uppercase tracking-wide ${isLatest ? 'text-indigo-500' : 'text-slate-400'}`}>{weekday}</div>
                  <div className="text-xs font-semibold text-slate-700">{day}</div>
                </div>

                <div className="flex-1 min-w-0 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{
                    width: `${share}%`,
                    background: isLatest ? 'linear-gradient(90deg,#6C63FF,#8b5cf6)' : '#c7c9f5',
                  }} />
                </div>

                <span className="text-sm font-bold text-slate-900 tabular-nums w-9 text-right shrink-0">{fmtInt(clicks)}</span>

                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md tabular-nums w-14 text-center shrink-0 ${
                  h.deltaPct == null ? 'invisible'
                    : h.deltaPct >= 0 ? 'text-emerald-700 bg-emerald-50' : 'text-rose-600 bg-rose-50'
                }`}>
                  {h.deltaPct != null && `${h.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(h.deltaPct)}%`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
