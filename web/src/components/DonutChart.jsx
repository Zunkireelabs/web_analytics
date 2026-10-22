import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { SERIES } from '../lib/palette.js';

const COLORS = SERIES;

// Donut chart from [{ name, value }]. `title` is kept for compatibility but no
// longer rendered here — the parent Section owns the heading.
export default function DonutChart({ title, data }) {
  const rows = (data || []).filter((d) => Number(d.value) > 0);
  const total = rows.reduce((s, d) => s + Number(d.value), 0);

  return (
    <div className="card p-5 flex flex-wrap items-center gap-6">
      {rows.length === 0 ? (
        <div className="w-full py-9 text-center text-sm text-faint">No data yet.</div>
      ) : (
        <>
          <div className="relative shrink-0" style={{ width: 140, height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={rows} dataKey="value" nameKey="name" innerRadius={52} outerRadius={66}
                  paddingAngle={2} startAngle={90} endAngle={-270}>
                  {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="#fff" />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
              <div className="text-[22px] font-medium tnum text-fg leading-none">{total.toLocaleString()}</div>
              <div className="text-xs text-faint mt-1">sessions</div>
            </div>
          </div>

          <div className="flex-1 min-w-[180px]">
            {rows.map((r, i) => {
              const percentage = total ? Math.round((r.value / total) * 100) : 0;
              return (
                <div key={r.name} className="flex items-center justify-between py-2 border-b border-border last:border-0 text-sm">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="text-fg truncate">{r.name}</span>
                  </div>
                  <span className="tnum text-text pl-2 shrink-0">{percentage}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
