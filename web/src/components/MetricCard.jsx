// A single KPI tile with optional % delta vs a comparison value.
// `lowerIsBetter` flips the color logic (used for avg Search position).
// `loading` shows an animated skeleton placeholder while data is fetching.
export default function MetricCard({ label, value, prev, lowerIsBetter = false, format = (v) => v, loading = false, hint }) {
  if (loading) {
    return (
      <div className="card p-4">
        <div className="h-3 w-14 bg-slate-100 rounded animate-pulse" />
        <div className="h-7 w-20 bg-slate-200 rounded animate-pulse mt-2" />
        <div className="h-3 w-16 bg-slate-100 rounded animate-pulse mt-2" />
      </div>
    );
  }

  const cur = Number(value);
  const delta =
    prev != null && Number(prev) !== 0
      ? Math.round(((cur - Number(prev)) / Number(prev)) * 1000) / 10
      : null;

  let tone = 'text-gray-400';
  if (delta != null && delta !== 0) {
    const good = lowerIsBetter ? delta < 0 : delta > 0;
    tone = good ? 'text-green-600' : 'text-red-600';
  }
  const arrow = delta == null ? '' : delta > 0 ? '▲' : delta < 0 ? '▼' : '–';

  return (
    <div className="card card-hover p-4">
      <div className="text-xs text-slate-500">
        {label}{hint && <span className="text-slate-400"> · {hint}</span>}
      </div>
      <div className="text-2xl font-bold text-slate-900 mt-1 tracking-tight">
        {value == null ? '—' : format(cur)}
      </div>
      {delta != null && (
        <div className={`text-xs mt-1 ${tone}`}>
          {arrow} {Math.abs(delta)}% <span className="text-gray-400">vs prev</span>
        </div>
      )}
    </div>
  );
}
