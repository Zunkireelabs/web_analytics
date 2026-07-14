// Shared sparkline — smooth area + line from a number[]. Pure SVG, no deps.
// `stretch` fills the parent container (viewBox + preserveAspectRatio="none") instead of a
// fixed pixel size — used where the sparkline must fill a card's full width (StatCard).
export default function Sparkline({ data = [], color = '#6C63FF', width = 72, height = 24, fill = true, dot = true, stretch = false }) {
  const vals = (data || []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return stretch ? null : <svg width={width} height={height} aria-hidden />;

  const w = stretch ? 100 : width;
  const h = stretch ? 30 : height;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = w / (vals.length - 1);
  const pad = stretch ? 2 : 3;
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = vals.map((v, i) => [i * stepX, y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const id = `spk-${color.replace('#', '')}-${w}-${vals.length}`;
  const last = pts[pts.length - 1];

  const svgProps = stretch
    ? { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', className: 'w-full h-full' }
    : { width: w, height: h, viewBox: `0 0 ${w} ${h}`, className: 'overflow-visible shrink-0' };

  return (
    <svg {...svgProps} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.18" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        vectorEffect={stretch ? 'non-scaling-stroke' : undefined} />
      {dot && <circle cx={last[0]} cy={last[1]} r="2.1" fill="#fff" stroke={color} strokeWidth="1.4" />}
    </svg>
  );
}
