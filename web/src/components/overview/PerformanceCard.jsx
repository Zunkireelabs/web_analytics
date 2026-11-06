import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { TrayCard } from '../layout/Tray.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import { SERIES, STATUS, AXIS_TICK, CHART } from '../../lib/palette.js';
import { fmtDay, fmtRange } from '../../lib/format.js';
import { compact, pctDelta, seriesTotals, behaviorTotals } from '../../lib/overview-view.js';
import { BehaviorEmpty } from './BehaviorCards.jsx';

const LINE = SERIES[1];      // the same blue the traffic donut uses for Organic Search
const COMPARE = '#a3a3a3';

const GROUPS = {
  search: [
    { key: 'impressions', label: 'Impressions', value: (r) => (r.impressions == null ? null : Number(r.impressions)), total: (t) => t.impressions, fmt: (v) => compact(v) },
    { key: 'clicks', label: 'Clicks', value: (r) => (r.clicks == null ? null : Number(r.clicks)), total: (t) => t.clicks, fmt: (v) => compact(v) },
    { key: 'ctr', label: 'Average CTR', value: (r) => (r.impressions == null || r.clicks == null ? null : Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0), total: (t) => t.ctr, fmt: (v) => `${(v * 100).toFixed(2)}%` },
    { key: 'position', label: 'Avg position', value: (r) => (r.position != null ? Number(r.position) : null), total: (t) => t.position, fmt: (v) => (v == null ? '—' : Number(v).toFixed(1)), lowerIsBetter: true },
  ],
  visitors: [
    { key: 'users', label: 'Users', value: (r) => Number(r.users || 0), total: (t) => t.users, fmt: (v) => compact(v) },
    { key: 'sessions', label: 'Sessions', value: (r) => Number(r.sessions || 0), total: (t) => t.sessions, fmt: (v) => compact(v) },
    { key: 'conversions', label: 'Conversions', value: (r) => Number(r.conversions || 0), total: (t) => t.conversions, fmt: (v) => compact(v) },
  ],
  // What visitors DID, from the client's own PostHog. A metric PostHog did not return is null (a gap), never 0.
  // People is the busiest single day: summing daily people would count a returning person twice.
  behavior: [
    { key: 'pageviews', label: 'Pages viewed', value: (r) => (r.pageviews == null ? null : Number(r.pageviews)), total: (t) => t.pageviews, fmt: (v) => compact(v) },
    { key: 'visits', label: 'Visits', value: (r) => (r.sessions == null ? null : Number(r.sessions)), total: (t) => t.sessions, fmt: (v) => compact(v) },
    { key: 'actions', label: 'Actions taken', value: (r) => (r.events == null ? null : Number(r.events)), total: (t) => t.events, fmt: (v) => compact(v) },
    { key: 'people', label: 'People, busiest day', value: (r) => (r.people == null ? null : Number(r.people)), total: (t) => t.people, fmt: (v) => compact(v) },
  ],
};

function Delta({ metric, cur, prev, compareLabel }) {
  if (!compareLabel) return <small className="block mt-0.5 text-xs text-faint">this period</small>;
  if (cur == null || prev == null) return <small className="block mt-0.5 text-xs text-faint">no data {compareLabel}</small>;
  if (metric.lowerIsBetter) {
    const d = Math.round((cur - prev) * 10) / 10;
    if (d === 0) return <small className="block mt-0.5 text-xs text-faint">no change {compareLabel}</small>;
    const good = d < 0;
    return <small className="block mt-0.5 text-xs text-faint"><span className="font-medium" style={{ color: good ? STATUS.good.text : STATUS.critical.text }}>{Math.abs(d).toFixed(1)} {good ? 'better' : 'worse'}</span> {compareLabel}</small>;
  }
  const d = pctDelta(cur, prev);
  if (d == null) return <small className="block mt-0.5 text-xs text-faint">no data {compareLabel}</small>;
  if (d === 0) return <small className="block mt-0.5 text-xs text-faint">no change {compareLabel}</small>;
  return <small className="block mt-0.5 text-xs text-faint"><span className="font-medium" style={{ color: d > 0 ? STATUS.good.text : STATUS.critical.text }}>{d > 0 ? '+' : '−'}{Math.abs(d)}%</span> {compareLabel}</small>;
}

function ChartTip({ active, payload, metric, compareLabel }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bg-white rounded-control px-3 py-2 text-xs" style={{ boxShadow: '0 0 0 1px var(--border-2), 0 8px 24px rgba(0,0,0,.1)' }}>
      <div className="font-semibold text-fg mb-1">{fmtDay(row.date)}</div>
      <div className="flex justify-between gap-5 text-text">{metric.label}<span className="text-fg font-medium">{row.value == null ? '—' : metric.fmt(row.value)}</span></div>
      {compareLabel && <div className="flex justify-between gap-5 text-text">{compareLabel}<span className="text-fg font-medium">{row.prev == null ? '—' : metric.fmt(row.prev)}</span></div>}
    </div>
  );
}

// A day Search Console has not finalized yet has no impressions or clicks (null), and is left as a gap rather than drawn as a
// false zero.
// One card instead of eight numbers and a separate chart: pick the number, see its chart. A single line (never two
// scales on one chart), with the comparison as a dashed line behind it.
export default function PerformanceCard({ group, onGroup, series, compareSeries, compareLabel, start, end, channels, loading, behavior, siteId }) {
  const [metricKey, setMetricKey] = useState('impressions');
  const metrics = GROUPS[group];
  const metric = metrics.find((m) => m.key === metricKey) || metrics[0];

  const onBehavior = group === 'behavior';
  const curSeries = onBehavior ? (behavior?.series || []) : series;
  const prevSeries = onBehavior ? (behavior?.compareSeries || null) : compareSeries;
  const cur = useMemo(() => (onBehavior ? behaviorTotals(curSeries) : seriesTotals(curSeries)), [onBehavior, curSeries]);
  const prev = useMemo(() => (prevSeries?.length ? (onBehavior ? behaviorTotals(prevSeries) : seriesTotals(prevSeries)) : null), [onBehavior, prevSeries]);

  const rows = useMemo(() => (curSeries || []).map((r, i) => ({
    date: String(r.date).slice(0, 10),
    value: metric.value(r),
    prev: prevSeries?.[i] ? metric.value(prevSeries[i]) : null,
  })), [curSeries, prevSeries, metric]);
  // Behavior with nothing to draw yet: not connected, or connected and still filling in.
  const behaviorEmpty = onBehavior && !loading && !(behavior?.series || []).some((r) => r.pageviews != null || r.sessions != null || r.events != null);

  const sessions = (channels || []).reduce((a, c) => a + Number(c.sessions || 0), 0);
  const topChannel = [...(channels || [])].sort((a, b) => Number(b.sessions) - Number(a.sessions))[0];
  const topShare = topChannel && sessions ? Math.round((Number(topChannel.sessions) / sessions) * 100) : 0;
  const compareOn = Boolean(prevSeries && compareLabel);

  return (
    <TrayCard title="Performance" subtitle={start && end ? `Daily, ${fmtRange(start, end)}` : 'Daily'}
      action={(
        <SegmentedTabs options={[{ value: 'search', label: 'Search' }, { value: 'visitors', label: 'Visitors' }, { value: 'behavior', label: 'Behavior' }]} value={group}
          onChange={(g) => { onGroup(g); setMetricKey(GROUPS[g][0].key); }} />
      )}>
      {behaviorEmpty ? (
        <BehaviorEmpty siteId={siteId} connected={Boolean(behavior?.connected)} status={behavior?.status} canConnect={Boolean(behavior?.canConnect)} />
      ) : (<>
      <div className={`grid grid-cols-2 ${metrics.length === 3 ? 'md:grid-cols-4' : 'md:grid-cols-4'} border-y border-border`}>
        {metrics.map((m, i) => {
          const on = m.key === metric.key;
          return (
            <button key={m.key} type="button" aria-pressed={on} onClick={() => setMetricKey(m.key)}
              className={`relative text-left px-4 py-3.5 min-w-0 bg-white ${i % 2 === 1 ? 'border-l' : ''} ${i >= 2 ? 'border-t md:border-t-0' : ''} ${i > 0 ? 'md:border-l' : ''} border-border`}>
              <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: on ? LINE : 'transparent' }} />
              <span className="flex items-center gap-2 text-[13px] text-text">
                <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ boxShadow: `inset 0 0 0 ${on ? 4 : 1.5}px ${on ? LINE : '#c9c7c3'}` }} />{m.label}
              </span>
              {loading ? <span className="block h-7 w-20 mt-1.5 bg-muted rounded-control animate-pulse" /> : (
                <>
                  <span className={`block mt-1 text-[24px] leading-8 font-semibold tracking-[-0.03em] tnum ${on ? 'text-fg' : 'text-faint-2'}`}>{m.fmt(m.total(cur))}</span>
                  <Delta metric={m} cur={m.total(cur)} prev={prev ? m.total(prev) : null} compareLabel={compareOn ? compareLabel : null} />
                </>
              )}
            </button>
          );
        })}
        {group === 'visitors' && (
          <div className="px-4 py-3.5 min-w-0 border-border border-l border-t md:border-t-0">
            <span className="block text-[13px] text-text">Top channel</span>
            <span className="block mt-1 text-[20px] leading-8 font-semibold tracking-[-0.02em] text-fg truncate">{topChannel?.channel || '—'}</span>
            <small className="block mt-0.5 text-xs text-faint">{topChannel ? `${topShare}% of sessions` : 'no sessions yet'}</small>
          </div>
        )}
      </div>

      <div className="px-2 md:px-4 pt-3 pb-2">
        {loading ? (
          <div className="py-24 text-center text-sm text-faint">Loading…</div>
        ) : rows.length === 0 || rows.every((r) => r.value == null) ? (
          <div className="py-24 text-center text-sm text-faint">No data for this range.</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={rows} margin={{ top: 6, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={fmtDay} axisLine={false} tickLine={false} minTickGap={40} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={50} reversed={Boolean(metric.lowerIsBetter)}
                  domain={metric.lowerIsBetter ? ['auto', 'auto'] : [0, 'auto']} tickFormatter={(v) => metric.fmt(v)} />
                <Tooltip content={<ChartTip metric={metric} compareLabel={compareOn ? compareLabel : null} />} cursor={{ stroke: CHART.cursor }} />
                {compareOn && <Line type="linear" dataKey="prev" stroke={COMPARE} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />}
                <Line type="linear" dataKey="value" stroke={LINE} strokeWidth={2.5} dot={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: '#fff', fill: LINE }} connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-2 pt-1 pb-1.5 text-[12.5px] text-text">
              <span className="inline-flex items-center gap-2"><i className="w-4 border-t-2" style={{ borderColor: LINE }} /><b className="font-medium text-fg">{metric.label}</b> this period</span>
              {compareOn && <span className="inline-flex items-center gap-2"><i className="w-4 border-t-2 border-dashed" style={{ borderColor: COMPARE }} />{compareLabel}</span>}
              {metric.lowerIsBetter && <span className="text-faint">Lower is better</span>}
              <Link to={onBehavior ? '/reports' : '/insights'} className="ml-auto text-primary font-medium hover:underline">{onBehavior ? 'View in reports' : 'View performance report'}</Link>
            </div>
          </>
        )}
      </div>
      </>)}
    </TrayCard>
  );
}
