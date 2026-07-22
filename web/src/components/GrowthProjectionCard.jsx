import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Sparkles } from 'lucide-react';

const MONTH_LABELS = { 0: 'Today', 1: '+1mo', 2: '+2mo', 3: '+3mo' };

function formatVal(val) {
  if (val == null) return '—';
  if (typeof val === 'number') {
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 100000) return `${Math.round(val / 1000)}k`;
    return val.toLocaleString();
  }
  return val;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg z-50">
      <div className="text-slate-300 mb-0.5">{label}</div>
      <div className="font-semibold">{formatVal(payload[0].value)}{payload[0].payload.unit}</div>
    </div>
  );
}

export default function GrowthProjectionCard({ title, icon, color = '#6C63FF', unit = '', projection, loading, compact = false }) {
  const chartHeight = compact ? 75 : 140;
  const gradientId = `projFill-${title.replace(/[^a-zA-Z0-9]/g, '')}-${compact ? 'c' : 'f'}`;

  if (loading) {
    return (
      <div className="card p-4 flex flex-col h-full animate-pulse">
        <h3 className="text-xs font-bold text-slate-900 tracking-tight mb-2">{icon} {title}</h3>
        <div className="py-8 text-center text-xs text-slate-400 flex-1 flex items-center justify-center">Loading…</div>
      </div>
    );
  }

  const points = projection?.points || [];
  const rows = points.map((p) => ({
    label: MONTH_LABELS[p.monthsOut] ?? `+${p.monthsOut}mo`,
    value: p.value,
    unit,
  }));
  const first = points[0]?.value;
  const last = points[points.length - 1]?.value;
  const isFlat = points.length > 0 && points.every((p) => p.value === first);

  const delta = (first != null && last != null) ? (last - first) : 0;
  const pctChange = (first && first > 0) ? Math.round((delta / first) * 100) : 0;
  const unitLabel = compact && unit === '/week' ? '/wk' : unit;

  return (
    <div className={`card ${compact ? 'p-3.5' : 'p-6'} card-hover flex flex-col justify-between h-full bg-white/90 border border-slate-200/80 shadow-2xs hover:shadow-md transition-all duration-300 overflow-hidden`}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-1 mb-1">
          <h3 className={`${compact ? 'text-[11px]' : 'text-sm'} font-black text-slate-800 tracking-tight flex items-center gap-1 truncate`}>
            <span>{icon}</span> <span className="truncate">{title}</span>
          </h3>
          {!compact && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF] bg-[#6C63FF]/10 border border-[#6C63FF]/20 px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1 shadow-2xs">
              <Sparkles size={10} /> AI Projected
            </span>
          )}
        </div>

        {!isFlat && first != null && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-1.5 leading-none">
              <span className={`${compact ? 'text-xs' : 'text-2xl'} font-black text-slate-400 line-through opacity-70`}>{formatVal(first)}{unitLabel}</span>
              <span className="text-slate-300 font-bold text-xs">→</span>
              <span className={`${compact ? 'text-sm' : 'text-2xl'} font-black`} style={{ color }}>{formatVal(last)}{unitLabel}</span>
            </div>
            {delta > 0 && (
              <div className="pt-0.5">
                <span className={`inline-block ${compact ? 'text-[9px] px-1.5 py-0.2' : 'text-[10px] px-2 py-0.5'} font-black text-emerald-600 bg-emerald-50 border border-emerald-200/60 rounded-full`}>
                  +{formatVal(delta)}{unitLabel} {pctChange > 0 ? `(+${pctChange}%)` : ''}
                </span>
              </div>
            )}
            {!compact && <span className="text-[10px] text-slate-400 font-semibold w-full">3-month projected forecast</span>}
          </div>
        )}

        {isFlat ? (
          <div className={`flex-1 flex flex-col items-center justify-center text-center gap-1 ${compact ? 'py-2' : 'py-6'}`}>
            <span className={`${compact ? 'text-base' : 'text-2xl'} font-black text-slate-900 leading-tight`}>{formatVal(first)}{unitLabel}</span>
            <p className={`${compact ? 'text-[9px]' : 'text-[10px]'} text-slate-400 font-medium leading-relaxed max-w-[200px] line-clamp-2`}>
              {projection?.assumptions || 'Nothing open to project.'}
            </p>
          </div>
        ) : (
          <div className="mt-1">
            <ResponsiveContainer width="100%" height={chartHeight}>
              <AreaChart data={rows} margin={{ top: 4, right: 2, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: compact ? 8 : 11, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} />
                {!compact && <YAxis tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} width={32} />}
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} strokeDasharray="4 4"
                  fill={`url(#${gradientId})`}
                  dot={{ r: compact ? 2 : 4, fill: color, strokeWidth: 0 }} activeDot={{ r: compact ? 3 : 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {!compact && !isFlat && (
        <p className="text-[10px] text-slate-400 font-semibold leading-relaxed mt-2 pt-2 border-t border-slate-100">{projection?.assumptions}</p>
      )}
    </div>
  );
}


