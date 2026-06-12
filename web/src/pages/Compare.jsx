import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
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
  const [plan, setPlan] = useState('');
  const [planBusy, setPlanBusy] = useState(false);

  // Fetch comparison totals
  useEffect(() => {
    if (!siteId) return;
    setPlan('');
    setData(null);
    if (mode === 'month') {
      api.compare(siteId, a, b).then(setData).catch(() => setData(null));
    } else {
      api.compareRange(siteId, wA, addDays(wA, 6), wB, addDays(wB, 6)).then(setData).catch(() => setData(null));
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

  const genPlan = async () => {
    setPlanBusy(true); setPlan('');
    try {
      const result = mode === 'month'
        ? await api.aiCompare(siteId, a, b)
        : await api.aiCompareRange(siteId, wA, addDays(wA, 6), wB, addDays(wB, 6));
      setPlan(result.plan);
    } catch { setPlan('Could not generate a plan right now — try again.'); }
    finally { setPlanBusy(false); }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="Compare Performance"
        subtitle={mode === 'week' ? 'Week-over-week intelligence' : 'Month-over-month intelligence'}
        icon="📈"
        right={<>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full self-center" style={{ background: overall.bg, color: overall.c }}>{overall.t}</span>

          {/* Mode dropdown */}
          <label className="text-xs text-slate-500 self-center">
            View<br />
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white"
            >
              <option value="month">Month</option>
              <option value="week">Week</option>
            </select>
          </label>

          {mode === 'month' ? (<>
            <label className="text-xs text-slate-500">Month A<br />
              <input type="month" value={a} onChange={(e) => setA(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
            <span className="text-slate-400 pb-2">vs</span>
            <label className="text-xs text-slate-500">Month B<br />
              <input type="month" value={b} onChange={(e) => setB(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
          </>) : (<>
            <label className="text-xs text-slate-500">
              Week A start<br />
              <input type="date" value={wA} onChange={(e) => setWA(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
              <span className="block text-[10px] text-slate-400 mt-0.5">{weekLabel(wA)}</span>
            </label>
            <span className="text-slate-400 pb-4">vs</span>
            <label className="text-xs text-slate-500">
              Week B start<br />
              <input type="date" value={wB} onChange={(e) => setWB(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
              <span className="block text-[10px] text-slate-400 mt-0.5">{weekLabel(wB)}</span>
            </label>
          </>)}
        </>}
      />

      {/* ── AI summary card ── */}
      <div className="relative card overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,#6C63FF,#8b5cf6,#0ea5e9)' }} />
        <div className="p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl grid place-items-center text-white shadow-md shadow-indigo-500/30" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>✨</div>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-slate-800">AI Performance Summary</div>
                <div className="text-[11px] text-slate-400">{labelA} vs {labelB}</div>
              </div>
            </div>
            <button onClick={genPlan} disabled={planBusy || !data}
              className="text-sm font-semibold text-white rounded-xl px-4 py-2 shadow-md shadow-indigo-500/25 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              {planBusy ? 'Generating…' : '⚡ Generate Action Plan'}
            </button>
          </div>

          {!data ? <div className="h-4 w-2/3 bg-slate-100 rounded animate-pulse" /> : (
            <p className="text-sm leading-relaxed text-slate-700">
              {biggestDrop && biggestDrop.pct < 0 && <>{biggestDrop.label} fell <b className="text-rose-600">{Math.abs(biggestDrop.pct)}%</b> ({biggestDrop.va.toLocaleString()} → {biggestDrop.vb.toLocaleString()}) — the steepest decline. </>}
              {biggestGain && biggestGain.pct > 0
                ? <>{biggestGain.label} was the bright spot, up <b className="text-emerald-600">{biggestGain.pct}%</b>. </>
                : <>Nearly every metric softened this period. </>}
              To recover, refresh your top-performing pages and improve titles on queries with high impressions but low clicks.
            </p>
          )}

          {(planBusy || plan) && (
            <div className="flex items-start gap-2.5 mt-4">
              <div className="w-7 h-7 rounded-lg grid place-items-center text-white text-xs shrink-0" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>AI</div>
              <div className="flex-1 rounded-2xl rounded-tl-sm bg-slate-50 border border-slate-100 px-4 py-3 text-sm leading-relaxed text-slate-800 whitespace-pre-line">
                <div className="text-[11px] font-semibold text-indigo-500 mb-1">Action plan</div>
                {planBusy ? <span className="text-slate-400">Thinking…</span> : plan}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {METRICS.map((m) => (
          <StatCard key={m.key} label={m.label} icon={m.icon} color={m.color}
            data={sv(m.key)} value={db[m.key]} prev={da[m.key]} format={fmtInt} loading={!data} />
        ))}
      </div>

      {/* ── Biggest changes + radar ── */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="card-title">Biggest changes</div>
            <span className="text-[11px] text-slate-400">largest drops first</span>
          </div>
          {!data ? <div className="text-sm text-slate-400 py-4">Loading…</div> : (
            <div className="divide-y divide-slate-50">
              {byDrop.map((c, i) => {
                const up = c.pct >= 0;
                return (
                  <div key={c.key} className="flex items-center gap-3 py-2.5">
                    <span className="w-6 h-6 rounded-md grid place-items-center text-[11px] font-bold" style={{ background: `${c.color}1a`, color: c.color }}>{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-700">{c.label}</div>
                      <div className="text-[11px] text-slate-400">{c.va.toLocaleString()} → {c.vb.toLocaleString()}</div>
                    </div>
                    <MiniSpark data={c.spark} color={up ? '#16A34A' : '#EF4444'} />
                    <span className={`text-xs font-bold px-2 py-1 rounded-lg w-16 text-center shrink-0 ${up ? 'text-emerald-700 bg-emerald-50' : 'text-rose-600 bg-rose-50'}`}>
                      {up ? '▲' : '▼'} {Math.abs(c.pct)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-1">
            <div className="card-title">{mode === 'week' ? 'Week shape comparison' : 'Month shape comparison'}</div>
            <span className="text-[11px] text-slate-400">normalized</span>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <RadarChart data={radar} outerRadius={100}>
              <PolarGrid stroke="#e2e8f0" />
              <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11, fill: '#64748b' }} />
              <Radar name={labelA} dataKey="A" stroke="#c4b5fd" fill="#c4b5fd" fillOpacity={0.35} />
              <Radar name={labelB} dataKey="B" stroke="#6C63FF" fill="#6C63FF" fillOpacity={0.35} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Tooltip formatter={(v, n, p) => [(n === labelA ? p.payload.va : p.payload.vb).toLocaleString(), n]} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function MiniSpark({ data, color }) {
  const vals = (data || []).map(Number);
  if (vals.length < 2) return <span className="w-12 shrink-0" />;
  const max = Math.max(...vals), min = Math.min(...vals), range = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 48).toFixed(1)},${(18 - ((v - min) / range) * 16).toFixed(1)}`).join(' ');
  return <svg width="48" height="20" className="shrink-0"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
