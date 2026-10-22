import Sparkline from './Sparkline.jsx';
import Badge from './Badge.jsx';
import { CHART } from '../lib/palette.js';
import { 
  MousePointer, 
  Eye, 
  Award, 
  Users, 
  Clock, 
  Sparkles, 
  CheckCircle2, 
  Calendar, 
  Compass,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';

const EMOJI_MAP = {
  '🖱': MousePointer,
  '👁': Eye,
  '🏅': Award,
  '👥': Users,
  '⏱': Clock,
  '✨': Sparkles,
  '✅': CheckCircle2,
  '📅': Calendar,
  '🧭': Compass,
};

// Premium KPI tile: icon + label, big value, trend pill, and a live mini-sparkline.
// `color` is kept for caller compatibility; KPI tiles are monochrome.
export default function StatCard({
  label, value, prev, data = [], icon, color = CHART.highlight,
  format = (v) => v, hint, lowerIsBetter = false, loading = false,
}) {
  if (loading) {
    return (
      <div className="card p-5 relative overflow-hidden animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-6 w-24 bg-muted rounded-control" />
          <div className="h-5 w-12 bg-muted rounded-control" />
        </div>
        <div className="h-8 w-20 bg-muted rounded-control mt-4" />
        <div className="h-10 w-full bg-muted rounded-control mt-3" />
      </div>
    );
  }

  const cur = Number(value);
  const delta = prev != null && Number(prev) !== 0
    ? Math.round(((cur - Number(prev)) / Number(prev)) * 1000) / 10
    : null;
  const good = delta == null || delta === 0 ? null : (lowerIsBetter ? delta < 0 : delta > 0);

  const LucideIcon = typeof icon === 'string' && EMOJI_MAP[icon] ? EMOJI_MAP[icon] : null;

  return (
    <div className="card card-hover p-4.5 relative overflow-hidden flex flex-col justify-between group">
      <div>
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-control bg-muted text-text grid place-items-center text-sm shrink-0">
              {LucideIcon ? <LucideIcon size={14} strokeWidth={2} /> : icon}
            </span>
            <span className="text-[13px] font-medium text-text truncate" title={label}>
              {label}{hint && <span className="text-faint font-normal"> · {hint}</span>}
            </span>
          </div>
          {delta != null && (
            <Badge tone={good == null ? 'grey' : good ? 'green' : 'red'} className="shrink-0">
              {good != null && (good ? <ArrowUpRight size={12} strokeWidth={2} /> : <ArrowDownRight size={12} strokeWidth={2} />)}
              {Math.abs(delta)}%
            </Badge>
          )}
        </div>

        <div className="text-2xl font-semibold tracking-[-0.02em] text-fg tnum mt-4 leading-none">
          {value == null ? '—' : format(cur)}
        </div>
      </div>

      <div className="mt-4 h-9 w-full">
        <Sparkline data={data} color={CHART.highlight} stretch dot={false} height={32} />
      </div>
    </div>
  );
}
