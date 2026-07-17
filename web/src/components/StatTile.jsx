import { Link } from 'react-router-dom';
import { useCountUp } from '../useCountUp.js';
import { AlertTriangle, Sparkles, Bot, Clock } from 'lucide-react';

const EMOJI_MAP = {
  '⚠️': AlertTriangle,
  '✨': Sparkles,
  '🤖': Bot,
  '🕐': Clock,
};

const TONE = {
  critical: { text: 'text-rose-600', chipBg: '#fee2e220', chipColor: '#e11d48' },
  accent: { text: 'text-[#6C63FF]', chipBg: '#6C63FF1a', chipColor: '#6C63FF' },
  warning: { text: 'text-amber-600', chipBg: '#f59e0b1a', chipColor: '#f59e0b' },
  success: { text: 'text-emerald-600', chipBg: '#10b9811a', chipColor: '#10b981' },
  default: { text: 'text-slate-900', chipBg: '#f1f5f9', chipColor: '#64748b' },
};

// A small icon chip gives each tile a distinct identity at a glance instead
// of four identical text blocks that only differ by their numbers — same
// "icon chip + tone" language the rest of Command Center's cards use.
// Optional `to`: renders the whole tile as a nav link (e.g. the Analysis
// Status tile linking to the orchestration diagram) instead of static div —
// the one visual entry point from Command Center into /ai-orchestration.
export default function StatTile({ label, value, sub, tone = 'default', icon, loading, to }) {
  const animated = useCountUp(value);
  const t = TONE[tone] || TONE.default;

  if (loading) {
    return (
      <div className="card p-4">
        <div className="h-3 w-20 bg-slate-100 rounded animate-pulse mb-2.5" />
        <div className="h-7 w-14 bg-slate-200 rounded animate-pulse" />
      </div>
    );
  }
  const Wrapper = to ? Link : 'div';
  const wrapperProps = to ? { to } : {};
  const LucideIcon = typeof icon === 'string' && EMOJI_MAP[icon] ? EMOJI_MAP[icon] : null;

  return (
    <Wrapper {...wrapperProps} className={`card card-hover p-4 block ${to ? 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        {icon && (
          <span className="w-6 h-6 rounded-lg grid place-items-center shrink-0" style={{ background: t.chipBg, color: t.chipColor }}>
            {LucideIcon ? <LucideIcon size={12} strokeWidth={2.5} /> : icon}
          </span>
        )}
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      </div>
      <div className={`text-2xl font-black tracking-tight tabular-nums ${t.text}`}>
        {typeof value === 'number' ? animated : value}
      </div>
      {sub && <div className="text-[10px] text-slate-450 font-semibold mt-1.5">{sub}</div>}
    </Wrapper>
  );
}
