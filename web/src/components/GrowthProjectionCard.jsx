import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import Badge from './Badge.jsx';
import { CHART, AXIS_TICK } from '../lib/palette.js';

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
    <div className="bg-fg text-white text-xs rounded-control px-2.5 py-1.5 z-50">
      <div className="text-white/60 mb-0.5">{label}</div>
      <div className="font-medium tnum">{formatVal(payload[0].value)}{payload[0].payload.unit}</div>
    </div>
  );
}

// Every mark is the single accent (CHART.highlight). `compact` renders one cell
// for the hairline projections strip (the parent supplies the surrounding card).
export default function GrowthProjectionCard({ title, unit = '', projection, loading, compact = false }) {
  const chartHeight = compact ? 44 : 140;

  if (loading) {
    return (
      <div className={compact ? 'bg-white px-4 py-3.5' : 'card px-4 py-4'}>
        <div className="text-[13px] text-text truncate">{title}</div>
        <div className="h-10 bg-muted rounded-control animate-pulse mt-2" />
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

  const chart = !isFlat && (
    <div className={compact ? 'mt-auto pt-2' : 'mt-3'}>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <AreaChart data={rows} margin={{ top: 4, right: 2, left: compact ? 2 : -10, bottom: 0 }}>
          {!compact && <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />}
          <XAxis dataKey="label" tick={compact ? { ...AXIS_TICK, fontSize: 10 } : AXIS_TICK} axisLine={false} tickLine={false}
            {...(compact ? { interval: 'preserveStartEnd', height: 14 } : {})} />
          {!compact && <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />}
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey="value" stroke={CHART.highlight} strokeWidth={1.5} strokeDasharray="4 3"
            fill={CHART.highlight} fillOpacity={0.06}
            dot={{ r: 2, fill: CHART.highlight, strokeWidth: 0 }} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );

  const body = (
    <>
      <div className={compact ? 'text-[13px] text-text truncate' : 'flex items-center justify-between gap-2'}>
        {compact ? title : (
          <>
            <h3 className="text-sm font-medium text-fg truncate">{title}</h3>
            <Badge tone="primary" className="shrink-0">AI projected</Badge>
          </>
        )}
      </div>

      {!isFlat && first != null && (
        <>
          <div className="mt-1 flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[13px] text-faint tnum">{formatVal(first)}{unitLabel} →</span>
            <span className="text-[20px] font-medium tracking-[-0.02em] text-fg tnum">{formatVal(last)}</span>
            {unitLabel && <span className="text-[13px] text-faint">{unitLabel}</span>}
          </div>
          {delta > 0 && (
            <Badge tone="green" className="mt-1.5 self-start">
              +{formatVal(delta)}{unitLabel}{pctChange > 0 ? ` (+${pctChange}%)` : ''}
            </Badge>
          )}
          {!compact && <span className="text-xs text-faint mt-1">3-month projected forecast</span>}
        </>
      )}

      {isFlat && (
        <>
          <div className="mt-1 text-[20px] font-medium tracking-[-0.02em] text-fg tnum">
            {formatVal(first)}{unitLabel && <span className="text-[13px] text-faint font-normal">{unitLabel}</span>}
          </div>
          <p className="mt-1 text-xs leading-4 text-faint line-clamp-2">
            {projection?.assumptions || 'Nothing open to project.'}
          </p>
        </>
      )}

      {chart}

      {!compact && !isFlat && (
        <p className="text-xs text-faint mt-2 pt-2 border-t border-border">{projection?.assumptions}</p>
      )}
    </>
  );

  return (
    <div className={compact ? 'bg-white px-4 py-3.5 min-w-0 flex flex-col h-full' : 'card px-4 py-4 flex flex-col h-full'}>
      {body}
    </div>
  );
}
