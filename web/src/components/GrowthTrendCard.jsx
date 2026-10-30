import { useState } from 'react';
import { ComposedChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { TrayCard } from './layout/Tray.jsx';
import { fmtDay } from '../lib/format.js';
import { CHART, AXIS_TICK } from '../lib/palette.js';

// Generic single-metric trend card for the Growth page — health score,
// competitor readiness, Authority Score, AI Recommendation rate all share
// this same real "first -> latest, real delta, real series" shape (see
// server/agents/lib/growth-report.js's summarize* helpers), unlike
// PerformanceTrendCard which is specifically shaped for the 3-metric GSC
// toggle. Every empty/singular state here reflects real sparse data, never
// a fabricated line to fill the chart. Every mark uses the single accent
// (CHART.highlight). No manual "growth target" layer here
// — all 4 metrics this card renders now get an AI-computed projection
// (GrowthProjectionCard.jsx) instead of a human-entered target.

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-fg text-white text-xs rounded-control px-2.5 py-1.5 space-y-0.5">
      <div className="text-white/60 mb-0.5">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="font-medium tnum flex items-center gap-1.5">
          {p.value}{unit}
        </div>
      ))}
    </div>
  );
}

export default function GrowthTrendCard({ id, title, subtitle, unit = '', data, loading, emptyMessage, action }) {
  const [actionState, setActionState] = useState('idle'); // idle | running | error
  const [actionMessage, setActionMessage] = useState(null);

  const runAction = async () => {
    setActionState('running');
    setActionMessage(null);
    try {
      const result = await action.run();
      setActionMessage(result?.message || null);
      setActionState('idle');
    } catch (err) {
      setActionMessage(err.message || 'Could not run — try again.');
      setActionState('error');
    }
  };

  const rows = (data?.series || []).map((r) => ({
    // The API may send a full ISO timestamp, so trim to the day before formatting.
    date: fmtDay(String(r.date).slice(0, 10)),
    value: r.value ?? r.score ?? r.mentionRate ?? null,
  })).filter((r) => r.value != null);

  return (
    <TrayCard className="flex flex-col h-full" title={title} subtitle={subtitle}
      action={rows.length >= 2 && data.delta != null ? (
        <Badge tone={data.delta >= 0 ? 'green' : 'red'} className="shrink-0">
          {data.delta >= 0 ? '+' : '\u2212'}{Math.abs(data.delta)}{unit}
        </Badge>
      ) : null}>

      {loading ? (
        <div className="border-t border-border px-4 py-10 text-center text-[13px] text-faint flex-1 flex items-center justify-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="border-t border-border flex-1 px-4 py-10 text-center text-[13px] text-faint flex flex-col items-center justify-center gap-3">
          <p>{emptyMessage || 'No real data yet.'}</p>
          {action && (
            <>
              <Button write variant="light" size="sm" onClick={runAction} disabled={actionState === 'running'}>
                {actionState === 'running' ? 'Running…' : action.label}
              </Button>
              {actionMessage && <p className="text-xs text-faint max-w-xs">{actionMessage}</p>}
            </>
          )}
        </div>
      ) : rows.length === 1 ? (
        <div className="border-t border-border flex-1 px-4 py-8 text-center flex flex-col justify-center">
          <p className="text-[20px] font-medium text-fg tnum">{rows[0].value}{unit}</p>
          <p className="text-[13px] text-faint mt-1">Only one real data point so far — a trend needs at least two.</p>
        </div>
      ) : (
        <div className="border-t border-border flex-1 flex flex-col justify-end px-2 pt-3 pb-2">
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />
              <Tooltip content={<CustomTooltip unit={unit} />} />
              <Area type="monotone" dataKey="value" stroke={CHART.highlight} strokeWidth={1.5}
                fill={CHART.highlight} fillOpacity={0.08} dot={false} activeDot={{ r: 3 }} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </TrayCard>
  );
}
