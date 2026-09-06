import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import Sparkline from '../components/Sparkline.jsx';
import { ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar, Legend, Tooltip } from 'recharts';

const fmtInt = (v) => Number(v).toLocaleString();

// Month helpers
function ym(offset = 0) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return d.toISOString().slice(0, 7); }
function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate();
  return { start: `${m}-01`, end: `${m}-${String(last).padStart(2, '0')}` };
}

// Week helpers
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStart(offsetWeeks = 0) {
  const d = new Date();
  const toMon = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - toMon - offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}
function weekLabel(start) {
  const end = addDays(start, 6);
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return s.getUTCMonth() === e.getUTCMonth()
    ? `${fmt(s).split(' ')[0]} ${+fmt(s).split(' ')[1]}–${e.getUTCDate()}`
    : `${fmt(s)} – ${fmt(e)}`;
}

const pctChange = (a, b) => { a = Number(a) || 0; b = Number(b) || 0; if (a === 0) return b > 0 ? 100 : 0; return Math.round(((b - a) / a) * 100); };

const METRICS = [
  { key: 'clicks', label: 'Clicks', icon: '🖱', color: '#6C63FF' },
  { key: 'impressions', label: 'Impressions', icon: '👁', color: '#8b5cf6' },
  { key: 'users', label: 'Users', icon: '👥', color: '#10b981' },
  { key: 'new_users', label: 'New users', icon: '✨', color: '#0ea5e9' },
  { key: 'sessions', label: 'Sessions', icon: '⏱', color: '#14b8a6' },
  { key: 'conversions', label: 'Conversions', icon: '✅', color: '#d946ef' },
];

export default function Compare({ siteId }) {
  const [mode, setMode] = useState('month'); // 'month' | 'week'

  // Month state
  const [a, setA] = useState(ym(-1));
  const [b, setB] = useState(ym(0));

  // Week state
  const [wA, setWA] = useState(weekStart(1));
  const [wB, setWB] = useState(weekStart(0));

  const [data, setData] = useState(null);
  const [series, setSeries] = useState([]);
  const [error, setError] = useState(false);

  // Fetch comparison totals
  useEffect(() => {
    if (!siteId) return;
    setData(null);
    setError(false);
    if (mode === 'month') {
      api.compare(siteId, a, b).then(setData).catch(() => { setData(null); setError(true); });
    } else {
      api.compareRange(siteId, wA, addDays(wA, 6), wB, addDays(wB, 6)).then(setData).catch(() => { setData(null); setError(true); });
    }
  }, [siteId, mode, a, b, wA, wB]);

  // Fetch daily series for sparklines (period B)
  useEffect(() => {
    if (!siteId) return;
    const { start, end } = mode === 'month' ? monthRange(b) : { start: wB, end: addDays(wB, 6) };
    api.series(siteId, start, end).then(setSeries).catch(() => setSeries([]));
  }, [siteId, mode, b, wB]);

  const da = data?.a || {}, db = data?.b || {};
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));
  const changes = METRICS.map((m) => ({ ...m, va: Number(da[m.key] || 0), vb: Number(db[m.key] || 0), pct: pctChange(da[m.key], db[m.key]), spark: sv(m.key) }));
  const byDrop = [...changes].sort((x, y) => x.pct - y.pct);
  const biggestDrop = byDrop[0];
  const biggestGain = [...changes].sort((x, y) => y.pct - x.pct)[0];

  const radar = METRICS.map((m) => { const va = Number(da[m.key] || 0), vb = Number(db[m.key] || 0); const mx = Math.max(va, vb, 1); return { metric: m.label, A: Math.round((va / mx) * 100), B: Math.round((vb / mx) * 100), va, vb }; });

  const net = changes.reduce((s, c) => s + c.pct, 0);
  const overall = net > 5 ? { t: 'Trending up', c: '#16A34A', bg: '#dcfce7' } : net < -5 ? { t: 'Trending down', c: '#EF4444', bg: '#fee2e2' } : { t: 'Roughly flat', c: '#64748B', bg: '#f1f5f9' };

  const labelA = mode === 'week' ? weekLabel(wA) : a;
  const labelB = mode === 'week' ? weekLabel(wB) : b;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 relative font-sans fade-up">

      {/* Decorative Glows */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[145px] bg-indigo-500/10 opacity-50 pulse-glow" />
        <div className="absolute bottom-10 left-1/4 w-[500px] h-[500px] rounded-full blur-[125px] bg-purple-500/8 opacity-45 pulse-glow" />
      </div>

      {error && (
        <div className="card p-4 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 text-center">
          Unable to load this comparison right now. Try refreshing.
        </div>
      )}

      {/* Page Header and Comparison Controls combined */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-2">
        <PageHeader
          title="Compare Performance"
          subtitle={mode === 'week' ? 'Week-over-week intelligence analysis' : 'Month-over-month intelligence analysis'}
          icon="📈"
        />
        
        {/* Mode selector + date inputs stretch full-width on mobile (w-full +
            flex-1) — at their natural content width they left a big dead gap
            on the right of this full-width card, same issue as Overview's
            date bar. The status badge stays natural-width; it's a label, not
            something that should be artificially stretched. */}
        <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md p-3.5 rounded-2xl flex flex-wrap items-center gap-3.5 z-10 shadow-sm">
          {/* Mode Selector */}
          <div className="flex flex-1 sm:flex-none bg-slate-100/70 p-0.5 rounded-xl border border-slate-200/30">
            <button onClick={() => setMode('month')}
              className={`flex-1 sm:flex-none text-center text-[10px] font-bold px-3.5 py-1.5 rounded-lg transition ${
                mode === 'month' ? 'bg-white text-indigo-600 shadow-sm active-pill-shadow' : 'text-slate-500 hover:text-slate-800'
              }`}>
              Month
            </button>
            <button onClick={() => setMode('week')}
              className={`flex-1 sm:flex-none text-center text-[10px] font-bold px-3.5 py-1.5 rounded-lg transition ${
                mode === 'week' ? 'bg-white text-indigo-600 shadow-sm active-pill-shadow' : 'text-slate-500 hover:text-slate-800'
              }`}>
              Week
            </button>
          </div>

          <span className="shrink-0 text-xs font-bold px-2.5 py-1 rounded-full border bg-indigo-500/5 border-indigo-500/10 text-indigo-600 shadow-sm">
            {overall.t}
          </span>

          {/* Date inputs depending on mode */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {mode === 'month' ? (
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                <input type="month" value={a} onChange={(e) => setA(e.target.value)}
                  className="flex-1 sm:flex-none min-w-0 bg-white border border-slate-200/80 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm sm:w-[120px]" />
                <span className="text-slate-400 font-bold shrink-0">vs</span>
                <input type="month" value={b} onChange={(e) => setB(e.target.value)}
                  className="flex-1 sm:flex-none min-w-0 bg-white border border-slate-200/80 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm sm:w-[120px]" />
              </div>
            ) : (
              <div className="flex flex-wrap items-start gap-2 w-full sm:w-auto">
                <div className="flex flex-col flex-1 sm:flex-none min-w-0">
                  <input type="date" value={wA} onChange={(e) => setWA(e.target.value)}
                    className="w-full sm:w-[125px] bg-white border border-slate-200/80 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm" />
                  <span className="text-[8px] font-bold text-slate-400 mt-1 px-1">{weekLabel(wA)}</span>
                </div>
                <span className="text-slate-400 font-bold shrink-0 self-start mt-1.5">vs</span>
                <div className="flex flex-col flex-1 sm:flex-none min-w-0">
                  <input type="date" value={wB} onChange={(e) => setWB(e.target.value)}
                    className="w-full sm:w-[125px] bg-white border border-slate-200/80 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm" />
                  <span className="text-[8px] font-bold text-slate-400 mt-1 px-1">{weekLabel(wB)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Intelligence summary block */}
      <div className="rounded-3xl border border-indigo-500/10 p-5 bg-gradient-to-br from-indigo-500/[0.02] via-purple-500/[0.01] to-white/70 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl grid place-items-center text-white bg-gradient-to-br from-indigo-500 to-purple-600 shadow-md shadow-indigo-500/20">📊</div>
          <div className="leading-tight">
            <h3 className="text-sm font-extrabold text-slate-950 tracking-tight">Performance Summary</h3>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{labelA} vs {labelB}</p>
          </div>
        </div>

        <div className="mt-4">
          {!data ? (
            <div className="h-4 w-2/3 bg-slate-100 rounded animate-pulse" />
          ) : (
            <p className="text-sm leading-relaxed text-slate-700 font-medium">
              {biggestDrop && biggestDrop.pct < 0 && (
                <>
                  <span className="font-bold text-slate-900">{biggestDrop.label}</span> fell{' '}
                  <span className="text-rose-500 font-extrabold">{Math.abs(biggestDrop.pct)}%</span>{' '}
                  <span className="text-slate-500">({biggestDrop.va.toLocaleString()} → {biggestDrop.vb.toLocaleString()})</span>, representing the steepest decline.{' '}
                </>
              )}
              {biggestGain && biggestGain.pct > 0 ? (
                <>
                  <span className="font-bold text-slate-900">{biggestGain.label}</span> was the strongest area, growing{' '}
                  <span className="text-emerald-500 font-extrabold">+{biggestGain.pct}%</span>.{' '}
                </>
              ) : (
                <>Almost all metrics softened over this period.</>
              )}
            </p>
          )}
        </div>
      </div>

      {/* KPI grid — always 2 cols (even below sm) so 6 cards stacked
          one-per-row doesn't turn into a long mobile scroll. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        {METRICS.map((m) => (
          <StatCard key={m.key} label={m.label} icon={m.icon} color={m.color}
            data={sv(m.key)} value={db[m.key]} prev={da[m.key]} format={fmtInt} loading={!data} />
        ))}
      </div>

      {/* Biggest changes + radar */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        <div className="card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-baseline justify-between mb-5">
              <h3 className="text-base font-bold text-slate-900 tracking-tight">Steepest Changes</h3>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Largest declines first</span>
            </div>
            
            {!data ? (
              <div className="py-14 text-center text-sm text-slate-400 animate-pulse font-medium">Loading details…</div>
            ) : (
              <div className="divide-y divide-slate-100/50">
                {byDrop.map((c, i) => {
                  const up = c.pct >= 0;
                  return (
                    <div key={c.key} className="flex items-center gap-3 py-3 hover:bg-slate-50/50 rounded-xl px-1 transition duration-150 group">
                      <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-extrabold shrink-0" 
                        style={{ background: `${c.color}12`, color: c.color }}>
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-700 group-hover:text-slate-900 transition-colors">{c.label}</div>
                        <div className="text-[10px] font-medium text-slate-400 mt-0.5 tabular-nums">
                          {c.va.toLocaleString()} → {c.vb.toLocaleString()}
                        </div>
                      </div>
                      <div className="pr-2 shrink-0">
                        <Sparkline data={c.spark} color={up ? '#10b981' : '#f43f5e'} width={44} height={18} fill={false} dot={false} />
                      </div>
                      <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border w-16 text-center shrink-0 transition-colors ${
                        up ? 'text-emerald-600 bg-emerald-500/5 border-emerald-500/10' : 'text-rose-500 bg-rose-500/5 border-rose-500/10'
                      }`}>
                        {up ? '▲' : '▼'} {Math.abs(c.pct)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900 tracking-tight">Profile Shape Comparison</h3>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Normalized metrics</span>
            </div>
            
            <div className="w-full flex items-center justify-center py-2">
              <ResponsiveContainer width="100%" height={290}>
                <RadarChart data={radar} outerRadius={85} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                  <PolarGrid stroke="#f1f5f9" />
                  <PolarAngleAxis dataKey="metric" tick={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                  <Radar name={labelA} dataKey="A" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.18} />
                  <Radar name={labelB} dataKey="B" stroke="#6C63FF" fill="#6C63FF" fillOpacity={0.22} />
                  <Legend wrapperStyle={{ fontSize: 11, fontWeight: 600, paddingTop: 10 }} />
                  <Tooltip content={<CustomRadarTooltip labelA={labelA} labelB={labelB} />} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Custom glassmorphic tooltip for Radar chart
function CustomRadarTooltip({ active, payload, label, labelA, labelB }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-950/90 backdrop-blur-md text-white text-xs rounded-xl p-3 shadow-xl border border-slate-800">
      <div className="font-bold text-slate-400 mb-1.5 uppercase tracking-wide text-[9px]">{label}</div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4 font-semibold text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            {labelA}:
          </span>
          <span className="font-bold tabular-nums">{(payload[0].payload.va).toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4 font-semibold text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
            {labelB}:
          </span>
          <span className="font-bold tabular-nums">{(payload[1].payload.vb).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
