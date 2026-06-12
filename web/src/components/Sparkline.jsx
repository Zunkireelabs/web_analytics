// Tiny inline sparkline — smooth area + line from a number[]. Pure SVG, no deps.
export default function Sparkline({ data = [], color = '#6C63FF', width = 72, height = 24, fill = true }) {
  const vals = (data || []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return <svg width={width} height={height} aria-hidden />;

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = width / (vals.length - 1);
  const pad = 3;
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);
  const pts = vals.map((v, i) => [i * stepX, y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `spk-${color.replace('#', '')}-${width}-${vals.length}`;
  const last = pts[pts.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.1" fill="#fff" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}
