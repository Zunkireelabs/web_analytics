import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import Badge from './Badge.jsx';

// Hero KPI tile: icon + label, badge (change % or a neutral share), big value, comparison text.
// iconBg/iconColor are kept for caller compatibility; KPI tiles are monochrome.
export default function KpiCard({ icon: Icon, iconBg, iconColor, label, value, badge, sub, loading = false }) {
  if (loading) {
    return (
      <div className="card p-5 relative overflow-hidden animate-pulse">
        <div className="flex items-center justify-between">
          <div className="w-8 h-8 bg-muted rounded-control" />
          <div className="h-5 w-12 bg-muted rounded-control" />
        </div>
        <div className="h-8 w-20 bg-muted rounded-control mt-5" />
        <div className="h-3 w-24 bg-muted rounded-control mt-2" />
      </div>
    );
  }

  const isUp = badge?.tone === 'up';
  const isDown = badge?.tone === 'down';

  return (
    <div className="card card-hover p-4.5 relative overflow-hidden flex flex-col justify-between group">
      {/* Top row: Icon on the left, Badge on the right */}
      <div className="flex items-center justify-between gap-2">
        <span className="w-8 h-8 rounded-control bg-muted text-text grid place-items-center shrink-0">
          <Icon size={16} strokeWidth={2} />
        </span>

        {badge && (
          <Badge tone={isUp ? 'green' : isDown ? 'red' : 'grey'} className="shrink-0">
            {isUp && <ArrowUpRight size={12} strokeWidth={2} />}
            {isDown && <ArrowDownRight size={12} strokeWidth={2} />}
            {badge.text}
          </Badge>
        )}
      </div>

      {/* Main body content: Big Value, Label, and Sub-text */}
      <div className="mt-4">
        <div className="text-2xl font-semibold tracking-[-0.02em] text-fg tnum leading-none truncate">
          {value}
        </div>
        <div className="text-[13px] font-medium text-text mt-1.5 truncate" title={label}>
          {label}
        </div>
        {sub && (
          <div className="text-xs text-faint mt-2 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-border-2" />
            <span className="truncate">{sub}</span>
          </div>
        )}
      </div>
    </div>
  );
}
