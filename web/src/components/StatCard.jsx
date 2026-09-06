import Sparkline from './Sparkline.jsx';
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
export default function StatCard({
  label, value, prev, data = [], icon, color = '#6C63FF',
  format = (v) => v, hint, lowerIsBetter = false, loading = false,
}) {
  if (loading) {
    return (
      <div className="card p-5 relative overflow-hidden animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-6 w-24 bg-slate-100/80 rounded-md" />
          <div className="h-5 w-12 bg-slate-100/80 rounded-full" />
        </div>
        <div className="h-8 w-20 bg-slate-200/60 rounded-xl mt-4" />
        <div className="h-10 w-full bg-slate-55/80 rounded-lg mt-3" />
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
            <span 
              className="w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0 transition-transform duration-300 group-hover:scale-105 shadow-sm"
              style={{ background: `${color}12`, color }}
            >
              {LucideIcon ? <LucideIcon size={14} strokeWidth={2.25} /> : icon}
            </span>
            <span className="text-xs font-bold text-slate-500 truncate tracking-tight" title={label}>
              {label}{hint && <span className="text-slate-400 font-medium"> · {hint}</span>}
            </span>
          </div>
          {delta != null && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 border transition-colors flex items-center gap-0.5 ${
              good == null ? 'text-slate-400 bg-slate-50 border-slate-200/40'
                : good ? 'text-emerald-600 bg-emerald-500/5 border-emerald-500/10' 
                : 'text-rose-500 bg-rose-500/5 border-rose-500/10'}`}
            >
              {good != null && (good ? <ArrowUpRight size={10} strokeWidth={3} /> : <ArrowDownRight size={10} strokeWidth={3} />)}
              {Math.abs(delta)}%
            </span>
          )}
        </div>

        <div className="text-2xl font-black text-slate-950 mt-4 tracking-tight leading-none font-sans">
          {value == null ? '—' : format(cur)}
        </div>
      </div>

      <div className="mt-4 h-9 w-full">
        <Sparkline data={data} color={color} stretch dot={false} height={32} />
      </div>
    </div>
  );
}
