import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts';

// Light pastel palette — one distinct color per column.
const LIGHT = ['#fca5a5', '#fdba74', '#fde68a', '#86efac', '#5eead4', '#93c5fd', '#c4b5fd', '#f9a8d4'];
const truncate = (s, n = 12) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Vertical column chart for top queries / pages (by impressions, sorted).
export default function RankedBarChart({
  title, subtitle = 'by impressions', rows, labelKey = 'dim_value',
  valueKey = 'impressions', labelFormat = (v) => v, max = 6,
}) {
  const data = [...(rows || [])]
    .sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0))
    .slice(0, max)
    .map((r) => ({
      name: truncate(labelFormat(r[labelKey])),
      full: r[labelKey],
      value: Number(r[valueKey]) || 0,
      clicks: Number(r.clicks) || 0,
      pos: Number(r.position) || 0,
    }));

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-2">
        <div className="card-title">{title}</div>
        <span className="text-[11px] text-slate-400">{subtitle}</span>
      </div>

      {data.length === 0 ? (
        <div className="text-sm text-slate-400 py-6">No data.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 10, right: 8, left: -12, bottom: 44 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="name" interval={0} angle={-35} textAnchor="end" height={54}
              tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={30} />
            <Tooltip cursor={{ fill: 'rgba(108,99,255,0.06)' }}
              labelFormatter={(_, p) => (p && p[0] ? p[0].payload.full : '')}
              formatter={(v, _n, p) => [`${Number(v).toLocaleString()} impr · ${p.payload.clicks} clicks · #${p.payload.pos.toFixed(1)}`, '']} />
            <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={42}>
              {data.map((_, i) => <Cell key={i} fill={LIGHT[i % LIGHT.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
