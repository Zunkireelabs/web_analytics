import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

// Multi-line trend over the daily series. `lines` = [{ key, name, color, axis }].
// A line with `axis: 'right'` is plotted against a second Y-axis on the right —
// useful when two series have very different scales (e.g. clicks vs impressions).
export default function TrendChart({ data, lines, title }) {
  const rows = (data || []).map((r) => ({ ...r, date: String(r.date).slice(5) })); // MM-DD
  const hasRight = lines.some((l) => l.axis === 'right');
  const cid = (title || 'chart').replace(/[^a-z0-9]/gi, '');
  const gid = (l) => `${cid}-${l.key}`;

  return (
    <div className="card p-5">
      {title && <div className="card-title mb-3">{title}</div>}
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows} margin={{ top: 5, right: 12, left: -8, bottom: 0 }}>
          <defs>
            {lines.filter((l) => l.gradient).map((l) => (
              <linearGradient key={l.key} id={gid(l)} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor={l.gradient[0]} />
                <stop offset="1" stopColor={l.gradient[1]} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
          {hasRight && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />}
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {lines.map((l) => (
            <Line
              key={l.key}
              yAxisId={l.axis === 'right' ? 'right' : 'left'}
              type="monotone"
              dataKey={l.key}
              name={l.name}
              stroke={l.gradient ? `url(#${gid(l)})` : l.color}
              strokeWidth={2.5}
              strokeDasharray={l.dash ? '5 4' : undefined}
              dot={false}
              connectNulls
              legendType="plainline"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
