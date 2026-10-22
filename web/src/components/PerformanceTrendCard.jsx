import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ComposedChart, Area, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Target } from 'lucide-react';
import { CHART, AXIS_TICK } from '../lib/palette.js';
import { fmtDay } from '../lib/format.js';
import Section from './layout/Section.jsx';
import SegmentedTabs from './SegmentedTabs.jsx';
import Button from './Button.jsx';
import GrowthTargetForm, { buildChartRows } from './GrowthTargetForm.jsx';

const METRICS = [
  { key: 'impressions', label: 'Impressions', format: (v) => Math.round(v).toLocaleString() },
  { key: 'clicks', label: 'Clicks', format: (v) => Math.round(v).toLocaleString() },
  { key: 'ctr', label: 'CTR', format: (v) => `${(v * 100).toFixed(2)}%` },
];

function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-fg text-white text-xs rounded-control p-3 space-y-1">
      <div className="text-faint-2 mb-1">{fmtDay(label) || label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="font-medium flex items-center gap-1.5 text-sm">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.dataKey === 'plan' ? CHART.muted : CHART.highlight }} />
          {p.dataKey === 'plan' ? 'Planned: ' : ''}{metric.format(p.value)} <span className="text-faint-2 text-[11px]">{metric.label.toLowerCase()}</span>
        </div>
      ))}
    </div>
  );
}

export default function PerformanceTrendCard({ series, targets, loading, onTargetSaved, showClicksProjectionNote = false }) {
  const [metricKey, setMetricKey] = useState('impressions');
  const [editing, setEditing] = useState(false);
  const metric = METRICS.find((m) => m.key === metricKey);
  const rows = (series || []).map((r) => ({
    date: r.date,
    value: metric.key === 'ctr'
      ? (Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0)
      : Number(r[metric.key] || 0),
  }));
  const target = targets?.[metricKey] || null;
  const chartRows = buildChartRows(rows, target);

  return (
    <Section
      title="Performance trend"
      subtitle="Daily search performance over the selected range"
      action={<Link to="/insights" className="btn btn--light shrink-0">View performance report</Link>}
    >
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <div className="min-w-0 overflow-x-auto no-scrollbar">
            <SegmentedTabs options={METRICS.map((m) => ({ value: m.key, label: m.label }))} value={metricKey}
              onChange={(k) => { setMetricKey(k); setEditing(false); }} />
          </div>
          {metricKey === 'clicks' && showClicksProjectionNote ? (
            <span className="ml-auto text-xs text-primary whitespace-nowrap">AI-projected above</span>
          ) : metricKey !== 'clicks' && !editing && (
            <Button variant="ghost" size="sm" icon className="ml-auto" onClick={() => setEditing(true)}
              title={`Edit ${metric.label} growth target`} aria-label={`Edit ${metric.label} growth target`}>
              <Target size={14} />
            </Button>
          )}
        </div>

        <div className="p-4">
          {editing && metricKey !== 'clicks' && (
            <GrowthTargetForm metric={metricKey} unit={metric.key === 'ctr' ? ' (0-1)' : ''} initial={target}
              onCancel={() => setEditing(false)}
              onSaved={() => { setEditing(false); onTargetSaved?.(); }} />
          )}

          {loading ? (
            <div className="py-20 text-center text-sm text-faint">Loading trend…</div>
          ) : rows.length === 0 && !target ? (
            <div className="py-20 text-center text-sm text-faint">No data for this range.</div>
          ) : (
            <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={chartRows} margin={{ top: 5, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={(d) => fmtDay(d)} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={52}
                tickFormatter={(v) => metric.key === 'ctr' ? `${Math.round(v * 100)}%` : Number(v).toLocaleString()} />
              <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: CHART.cursor, strokeWidth: 1 }} />
              {target?.baselineValue == null && target != null && (
                <ReferenceLine y={target.value} stroke={CHART.highlight} strokeDasharray="5 5" strokeWidth={1.5}
                  label={{ value: `Goal: ${metric.format(target.value)} by ${String(target.date).slice(5, 10)}`, position: 'insideTopLeft', fontSize: 10, fill: CHART.highlight, fontWeight: 700 }} />
              )}
              <Area type="monotone" dataKey="value" stroke={CHART.highlight} strokeWidth={2.5}
                fill={CHART.highlight} fillOpacity={0.08} dot={false} activeDot={{ r: 5, strokeWidth: 0, fill: CHART.highlight }} connectNulls={false} />
              {target?.baselineValue != null && (
                <Line type="linear" dataKey="plan" stroke={CHART.muted} strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} connectNulls name="Planned" />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          )}
        </div>
      </div>
    </Section>
  );
}
