import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';

const COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7'];

// Donut chart from [{ name, value }]. `title` optional.
export default function DonutChart({ title, data }) {
  const rows = (data || []).filter((d) => Number(d.value) > 0);
  return (
    <div className="card p-5 fade-up">
      {title && <div className="card-title mb-2">{title}</div>}
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 py-10 text-center">No data yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
              {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
