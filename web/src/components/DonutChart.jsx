import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const COLORS = ['#6C63FF', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899'];

// Donut chart from [{ name, value }]. `title` optional.
export default function DonutChart({ title, data }) {
  const rows = (data || []).filter((d) => Number(d.value) > 0);
  const total = rows.reduce((s, d) => s + Number(d.value), 0);

  return (
    <div className="card p-6 flex flex-col justify-between fade-up">
      <div>
        {title && (
          <div className="mb-5">
            <h3 className="text-base font-bold text-slate-900 tracking-tight">{title}</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Sessions breakdown by user device type</p>
          </div>
        )}
        
        {rows.length === 0 ? (
          <div className="text-sm text-slate-400 py-14 text-center font-medium">No data yet.</div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center gap-6 py-2">
            <div className="relative shrink-0 mx-auto" style={{ width: 140, height: 140 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie 
                    data={rows} 
                    dataKey="value" 
                    nameKey="name" 
                    innerRadius={46} 
                    outerRadius={66} 
                    paddingAngle={rows.length > 1 ? 4 : 0}
                    stroke="none"
                    startAngle={90}
                    endAngle={-270}
                  >
                    {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                <div className="text-xl font-black text-slate-950 leading-none tabular-nums tracking-tight">
                  {total.toLocaleString()}
                </div>
                <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-1">Sessions</div>
              </div>
            </div>

            <div className="flex-1 min-w-0 w-full space-y-2.5">
              {rows.map((r, i) => {
                const percentage = total ? Math.round((r.value / total) * 100) : 0;
                return (
                  <div key={r.name} className="flex items-center justify-between text-xs font-semibold px-2.5 py-1 hover:bg-slate-50 rounded-lg transition duration-150">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-slate-600 truncate">{r.name}</span>
                    </div>
                    <span className="text-slate-900 font-bold tabular-nums pl-2 shrink-0">
                      {percentage}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
