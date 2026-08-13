import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, Area, Line, ReferenceLine, ReferenceDot, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { api } from '../api.js';

const GRANULARITIES = ['Day', 'Week', 'Month'];

// Presentational only — the stored series is always daily (see
// data-analyst-agent/app/db/migrations/versions/0001_initial_schema.py's
// metrics_catalog seed, every enabled metric is cadence='daily'). Bucketing
// a count metric (clicks, sessions) sums correctly; bucketing a ratio/rank/
// score metric (ctr, position, health_score) with a plain mean is an
// approximation — a true weighted average would need the paired weight
// metric's daily values too (e.g. gsc_ctr weighted by gsc_impressions),
// which this single-metric series endpoint doesn't carry.
function isSummable(unit) {
  return unit === 'count';
}

function bucketKey(dateStr, granularity) {
  if (granularity === 'Day') return dateStr;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (granularity === 'Month') return dateStr.slice(0, 7);
  // Week: Monday-start bucket, keyed by that Monday's date.
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

function bucketRows(rows, granularity, valueKeys, summable) {
  if (granularity === 'Day') return rows;
  const buckets = new Map();
  for (const row of rows) {
    const key = bucketKey(row.date, granularity);
    if (!buckets.has(key)) buckets.set(key, { date: key, sums: {}, counts: {} });
    const bucket = buckets.get(key);
    for (const k of valueKeys) {
      const v = row[k];
      if (v == null) continue;
      bucket.sums[k] = (bucket.sums[k] || 0) + v;
      bucket.counts[k] = (bucket.counts[k] || 0) + 1;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => {
      const out = { date: b.date };
      for (const k of valueKeys) {
        if (b.counts[k] == null) { out[k] = null; continue; }
        out[k] = summable ? b.sums[k] : b.sums[k] / b.counts[k];
      }
      return out;
    });
}

function formatLabel(dateStr, granularity) {
  const d = new Date(`${dateStr}${dateStr.length === 7 ? '-01' : ''}T00:00:00Z`);
  if (granularity === 'Month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (granularity === 'Week') return `Wk of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Axis ticks need to stay short at any width (46px), so a plain
// toLocaleString() on a value like 14542 — "14,542" — still doesn't fit and
// gets clipped by the SVG viewport, which is what read as a bare "000"
// before: only the tick's rightmost digits were inside the visible area.
function compactNumber(v) {
  if (v == null) return '';
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  const format = (v) => (unit === 'ratio' ? `${(v * 100).toFixed(1)}%` : Math.round(v * 100) / 100).toLocaleString();
  return (
    <div className="bg-slate-950/90 backdrop-blur-md text-slate-900 text-xs rounded-xl p-3 shadow-xl border border-slate-800 space-y-1">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      {payload.map((p) => p.value != null && (
        <div key={p.dataKey} className="font-bold flex items-center gap-1.5 text-sm">
          <span className={`w-1.5 h-1.5 rounded-full ${p.dataKey === 'forecast' ? 'bg-violet-400' : 'bg-sky-400'}`} />
          {p.dataKey === 'forecast' ? 'Forecast: ' : ''}{format(p.value)}
        </div>
      ))}
    </div>
  );
}

export default function AnalystTrendCard({ clientId, metrics, selectedMetricKey, onSelectMetric, insights = [] }) {
  const [granularity, setGranularity] = useState('Week');
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  const metric = metrics.find((m) => m.metric_key === selectedMetricKey) || metrics[0];

  useEffect(() => {
    if (!metric) return;
    setData(null);
    setError(null);
    api.analyst.series(clientId, metric.metric_key)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load trend'));
  }, [clientId, metric?.metric_key]);

  const chartRows = useMemo(() => {
    if (!data) return [];
    const summable = isSummable(metric?.unit);
    const actualRows = bucketRows(data.series, granularity, ['value'], summable);
    const lastActualDate = data.series.length ? data.series[data.series.length - 1].date : null;

    const forecastPoints = data.forecast?.status === 'ok' ? data.forecast.points : [];
    const forecastRows = bucketRows(
      forecastPoints.map((p) => ({ date: p.target_date, estimate: p.point_estimate, lower: p.lower_bound, upper: p.upper_bound })),
      granularity, ['estimate', 'lower', 'upper'], false,
    );

    // Keyed merge (not concat) so the transition date — the last real
    // observation, which is also the forecast's anchor point — is one row
    // carrying both `value` and `forecast`, letting the dashed forecast
    // line visually pick up exactly where the actual line ends instead of
    // leaving a gap.
    const byDate = new Map();
    for (const r of actualRows) byDate.set(r.date, { date: r.date, value: r.value, forecast: null, band: null });
    for (const r of forecastRows) {
      const existing = byDate.get(r.date) || { date: r.date, value: null, forecast: null, band: null };
      existing.forecast = r.estimate;
      existing.band = r.lower != null && r.upper != null ? [r.lower, r.upper] : null;
      byDate.set(r.date, existing);
    }
    const lastActualBucket = lastActualDate ? bucketKey(lastActualDate, granularity) : null;
    if (lastActualBucket && byDate.has(lastActualBucket) && forecastRows.length) {
      byDate.get(lastActualBucket).forecast = byDate.get(lastActualBucket).value;
    }
    const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Anomaly/trend-shift markers — positioned at the bucket their real
    // date falls into, y-value read back off that bucket's own (possibly
    // aggregated) plotted value, never a separately-computed number.
    const anomalyMarkers = (metric?.anomalies || [])
      .map((a) => {
        const key = bucketKey(a.date, granularity);
        const row = byDate.get(key);
        return row?.value != null ? { date: key, value: row.value, direction: a.direction } : null;
      })
      .filter(Boolean);
    const trendShiftMarkers = insights
      .filter((i) => i.metric_key === metric?.metric_key && i.insight_type === 'trend_shift')
      .map((i) => {
        const key = bucketKey(i.period_start, granularity);
        const row = byDate.get(key);
        return row?.value != null ? { date: key, value: row.value, direction: i.evidence?.pct_change > 0 ? 'up' : 'down' } : null;
      })
      .filter(Boolean);

    return { rows: merged, lastActualDate, anomalyMarkers, trendShiftMarkers };
  }, [data, granularity, metric?.unit, metric?.anomalies, metric?.metric_key, insights]);

  return (
    <div className="an-panel p-6 flex flex-col justify-between">
      <div>
        <div className="flex flex-wrap items-start justify-between mb-6 gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">Trend & Forecast</h3>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              {metric?.display_name || 'Metric'} · {granularity.toLowerCase()} view, forecast band shaded
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={metric?.metric_key || ''}
              onChange={(e) => onSelectMetric(e.target.value)}
              className="an-input text-[11px] font-bold px-3 py-1.5 cursor-pointer"
            >
              {metrics.map((m) => <option key={m.metric_key} value={m.metric_key} className="bg-white text-slate-800">{m.display_name}</option>)}
            </select>
            <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200 shrink-0">
              {GRANULARITIES.map((g) => (
                <button key={g} onClick={() => setGranularity(g)}
                  className={`text-[11px] font-bold px-3 py-1.5 rounded-xl transition cursor-pointer ${
                    granularity === g
                      ? 'bg-slate-100 text-indigo-500 border border-white/10'
                      : 'text-slate-400 hover:text-slate-800'
                  }`}>
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <div className="py-20 text-center text-sm text-rose-600 font-medium">{error}</div>
        ) : !data ? (
          <div className="py-20 text-center text-sm text-slate-500 animate-pulse font-medium">Loading trend…</div>
        ) : chartRows.rows.length === 0 ? (
          <div className="py-20 text-center text-sm text-slate-500 font-medium">No data yet for this metric.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartRows.rows} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d) => formatLabel(d, granularity)}
                tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false}
                minTickGap={40} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} width={46}
                tickFormatter={(v) => metric?.unit === 'ratio' ? `${Math.round(v * 100)}%` : compactNumber(v)} />
              <Tooltip content={<CustomTooltip unit={metric?.unit} />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }}
                labelFormatter={(d) => formatLabel(d, granularity)} />
              {chartRows.lastActualDate && (
                <ReferenceLine x={bucketKey(chartRows.lastActualDate, granularity)} stroke="#cbd5e1" strokeDasharray="3 3"
                  label={{ value: 'Today', position: 'insideTopRight', fontSize: 9, fill: '#94a3b8', fontWeight: 700 }} />
              )}
              <Area type="monotone" dataKey="band" stroke="none" fill="#8b5cf6" fillOpacity={0.14} connectNulls={false} />
              <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2.5}
                fill="url(#trendFill)" dot={false} activeDot={{ r: 5, strokeWidth: 0, fill: '#8b5cf6' }} connectNulls={false} />
              <Line type="monotone" dataKey="forecast" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 5"
                dot={{ r: 2 }} connectNulls={false} />
              {chartRows.anomalyMarkers?.map((m, idx) => (
                <ReferenceDot key={`a-${idx}`} x={m.date} y={m.value} r={5}
                  fill={m.direction === 'high' ? '#fb7185' : '#38bdf8'} stroke="#ffffff" strokeWidth={1.5} />
              ))}
              {chartRows.trendShiftMarkers?.map((m, idx) => (
                <ReferenceDot key={`t-${idx}`} x={m.date} y={m.value} r={5} shape="diamond"
                  fill={m.direction === 'up' ? '#34d399' : '#fbbf24'} stroke="#ffffff" strokeWidth={1.5} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {data?.forecast?.status === 'ok' && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[9px] font-bold text-slate-500">
            <span>Model: <span className="text-slate-700">{data.forecast.model}</span></span>
            {data.forecast.horizon_periods && <span>Horizon: <span className="text-slate-700">{data.forecast.horizon_periods}d</span></span>}
            {data.forecast.confidence != null && <span>Confidence: <span className="text-slate-700">{Math.round(data.forecast.confidence * 100)}%</span></span>}
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> High anomaly</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" /> Low anomaly</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rotate-45 bg-emerald-400" /> Trend shift</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-violet-400" /> Forecast band</span>
          </div>
        )}
      </div>
    </div>
  );
}
