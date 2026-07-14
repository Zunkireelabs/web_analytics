import Sparkline from './Sparkline.jsx';

// Premium KPI tile: icon + label, big value, trend pill, and a live mini-sparkline.
export default function StatCard({
  label, value, prev, data = [], icon, color = '#6C63FF',
  format = (v) => v, hint, lowerIsBetter = false, loading = false,
}) {
  if (loading) {
    return (
      <div className="card p-4">
        <div className="h-6 w-6 bg-slate-100 rounded-lg animate-pulse" />
        <div className="h-7 w-20 bg-slate-200 rounded animate-pulse mt-3" />
        <div className="h-9 w-full bg-slate-50 rounded animate-pulse mt-2" />
      </div>
    );
  }

  const cur = Number(value);
  const delta = prev != null && Number(prev) !== 0
    ? Math.round(((cur - Number(prev)) / Number(prev)) * 1000) / 10
    : null;
  const good = delta == null || delta === 0 ? null : (lowerIsBetter ? delta < 0 : delta > 0);

  return (
    <div className="card card-hover p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg grid place-items-center text-sm shrink-0"
            style={{ background: `${color}1a`, color }}>{icon}</span>
          <span className="text-xs text-slate-500 truncate">
            {label}{hint && <span className="text-slate-400"> · {hint}</span>}
          </span>
        </div>
        {delta != null && (
          <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${
            good == null ? 'text-slate-400 bg-slate-50'
              : good ? 'text-emerald-700 bg-emerald-50' : 'text-rose-600 bg-rose-50'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '–'} {Math.abs(delta)}%
          </span>
        )}
      </div>

      <div className="text-2xl font-bold text-slate-900 mt-2.5 tracking-tight">
        {value == null ? '—' : format(cur)}
      </div>

      <div className="mt-1.5 h-9">
        <Sparkline data={data} color={color} stretch dot={false} />
      </div>
    </div>
  );
}
