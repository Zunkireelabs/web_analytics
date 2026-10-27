import { STATUS } from '../../lib/palette.js';
import Sparkline from '../Sparkline.jsx';

export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export const pathOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return url || '/'; } };

// Where a position falls: the chip says it in words, so a number is never the only signal.
export function RankChip({ position }) {
  if (position == null) return null;
  const tone = position <= 3 ? { bg: STATUS.good.tint, fg: STATUS.good.text, label: 'Top 3' }
    : position <= 10 ? { bg: '#eef0ff', fg: '#4338ca', label: 'Page 1' }
      : { bg: '#f3f3f2', fg: '#5c5c5c', label: `Page ${Math.ceil(position / 10)}` };
  return <span className="inline-flex items-center h-[22px] px-2 rounded-full text-xs font-medium shrink-0" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>;
}

export function Trend({ trend, width = 64, height = 22 }) {
  if (!trend) return <span className="text-xs text-faint">Not enough history yet</span>;
  const up = trend.pct != null && trend.pct > 0;
  const color = up ? STATUS.good.color : STATUS.neutral.color;
  return (
    <span className="inline-flex items-center gap-2">
      <Sparkline data={trend.points} color={color} width={width} height={height} fill={false} dot={false} />
      {trend.pct != null && <span className="text-xs tnum" style={{ color: up ? STATUS.good.text : STATUS.neutral.text }}>{trend.pct > 0 ? '+' : ''}{trend.pct}%</span>}
    </span>
  );
}

export const Pill = ({ children }) => (
  <span className="inline-flex items-center h-[22px] px-2 rounded-full text-xs font-medium bg-white text-fg" style={{ boxShadow: 'var(--ring)' }}>{children}</span>
);

export const PLAN_LABEL = { blog: 'Blog post', landing: 'Landing page', track: 'Tracking' };
