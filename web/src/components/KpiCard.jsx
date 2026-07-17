import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

// Hero KPI tile: icon + label, badge (change % or a neutral share), big value, comparison text.
export default function KpiCard({ icon: Icon, iconBg, iconColor, label, value, badge, sub, loading = false }) {
  if (loading) {
    return (
      <div className="card p-5 relative overflow-hidden animate-pulse">
        <div className="flex items-center justify-between">
          <div className="w-9 h-9 rounded-xl bg-slate-100/80" />
          <div className="h-5 w-12 bg-slate-100/80 rounded-full" />
        </div>
        <div className="h-8 w-20 bg-slate-200/60 rounded-xl mt-5" />
        <div className="h-3 w-24 bg-slate-100/80 rounded-md mt-2" />
      </div>
    );
  }

  const isUp = badge?.tone === 'up';
  const isDown = badge?.tone === 'down';

  return (
    <div className="card card-hover p-4.5 relative overflow-hidden flex flex-col justify-between group">
      {/* Top row: Icon on the left, Badge on the right */}
      <div className="flex items-center justify-between gap-2">
        <span 
          className="w-9 h-9 rounded-xl grid place-items-center shrink-0 transition-transform duration-300 group-hover:scale-105 shadow-sm"
          style={{ 
            background: iconBg, 
            color: iconColor,
            boxShadow: `0 6px 12px -3px ${iconColor}22`
          }}
        >
          <Icon size={16} strokeWidth={2.25} />
        </span>
        
        {badge && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 border transition-colors ${
            isUp ? 'text-emerald-600 bg-emerald-500/5 border-emerald-500/10'
              : isDown ? 'text-rose-500 bg-rose-500/5 border-rose-500/10'
              : 'text-indigo-600 bg-indigo-500/5 border-indigo-500/10'
          }`}>
            {isUp && <ArrowUpRight size={10} strokeWidth={3} />}
            {isDown && <ArrowDownRight size={10} strokeWidth={3} />}
            {badge.text}
          </span>
        )}
      </div>

      {/* Main body content: Big Value, Label, and Sub-text */}
      <div className="mt-4">
        <div className="text-2xl font-black text-slate-950 tracking-tight leading-none truncate font-sans">
          {value}
        </div>
        <div className="text-xs font-bold text-slate-500 tracking-tight mt-1.5 truncate" title={label}>
          {label}
        </div>
        {sub && (
          <div className="text-[10px] text-slate-400 font-semibold mt-2 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-slate-200" />
            <span className="truncate">{sub}</span>
          </div>
        )}
      </div>
    </div>
  );
}
