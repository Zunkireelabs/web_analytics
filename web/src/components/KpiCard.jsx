import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

// Hero KPI tile: icon + label, badge (change % or a neutral share), big value, comparison text.
export default function KpiCard({ icon: Icon, iconBg, iconColor, label, value, badge, sub, loading = false }) {
  if (loading) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-slate-100 animate-pulse" />
          <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
        </div>
        <div className="h-8 w-20 bg-slate-200 rounded animate-pulse mt-4" />
        <div className="h-3 w-28 bg-slate-100 rounded animate-pulse mt-3" />
      </div>
    );
  }

  return (
    <div className="card card-hover p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-9 h-9 rounded-xl grid place-items-center shrink-0" style={{ background: iconBg, color: iconColor }}>
            <Icon size={17} strokeWidth={2.25} />
          </span>
          <span className="text-[13px] font-medium text-slate-500 truncate">{label}</span>
        </div>
        {badge && (
          <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold px-2 py-1 rounded-full shrink-0 ${
            badge.tone === 'up' ? 'text-emerald-700 bg-emerald-50'
              : badge.tone === 'down' ? 'text-rose-600 bg-rose-50'
              : 'text-indigo-600 bg-indigo-50'
          }`}>
            {badge.tone === 'up' && <ArrowUpRight size={11} strokeWidth={3} />}
            {badge.tone === 'down' && <ArrowDownRight size={11} strokeWidth={3} />}
            {badge.text}
          </span>
        )}
      </div>
      <div className="text-[27px] font-bold text-slate-900 mt-3.5 tracking-tight leading-none truncate">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-2.5">{sub}</div>}
    </div>
  );
}
