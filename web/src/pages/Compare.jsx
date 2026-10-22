import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageToolbar from '../components/PageToolbar.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import Badge from '../components/Badge.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import { Tray, TrayCard } from '../components/layout/Tray.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Sparkline from '../components/Sparkline.jsx';
import { ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar, Legend, Tooltip } from 'recharts';
import { fmtSignedPct } from '../lib/format.js';
import { CHART, STATUS, AXIS_TICK } from '../lib/palette.js';

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
  { key: 'clicks', label: 'Clicks' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'users', label: 'Users' },
  { key: 'new_users', label: 'New users' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'conversions', label: 'Conversions' },
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
  const overall = net > 5 ? { t: 'Trending up', tone: 'green' } : net < -5 ? { t: 'Trending down', tone: 'red' } : { t: 'Roughly flat', tone: 'grey' };

  const labelA = mode === 'week' ? weekLabel(wA) : a;
  const labelB = mode === 'week' ? weekLabel(wB) : b;

  // Month mode: "2026-10" → "October 2026"; week mode labels are already readable ("Oct 13–19").
  const longMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
  const shortMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' }); };
  const fmtLabel = (l) => (mode === 'month' ? longMonth(l) : l);
  const shortA = mode === 'month' ? shortMonth(a) : labelA;
  const shortB = mode === 'month' ? shortMonth(b) : labelB;

  const dateInput = 'h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg min-w-0 flex-1 md:flex-none';

  // Same delta maths the old KPI tiles used, so the numbers match what users saw before.
  const kpis = METRICS.map((m) => {
    const prev = da[m.key];
    const cur = Number(db[m.key]);
    const d = prev != null && Number(prev) !== 0 ? Math.round(((cur - Number(prev)) / Number(prev)) * 1000) / 10 : null;
    return {
      label: m.label,
      value: db[m.key] == null ? '—' : fmtInt(cur),
      delta: d == null ? undefined : { text: fmtSignedPct(d), tone: d > 0 ? 'good' : d < 0 ? 'bad' : undefined },
      sub: `vs ${fmtInt(Number(prev || 0))} in ${shortA}`,
      spark: sv(m.key),
    };
  });

  const summary = !data ? (
    <span className="block h-4 w-2/3 bg-muted rounded-control animate-pulse" />
  ) : (
    <>
      {biggestDrop && biggestDrop.pct < 0 && (
        <>
          <span className="text-fg">{biggestDrop.label}</span> fell{' '}
          <span className="text-[#b42318]">{'\u2212'}{Math.abs(biggestDrop.pct)}%</span>{' '}
          <span className="text-faint">({biggestDrop.va.toLocaleString()} → {biggestDrop.vb.toLocaleString()})</span>, representing the steepest decline.{' '}
        </>
      )}
      {biggestGain && biggestGain.pct > 0 ? (
        <>
          <span className="text-fg">{biggestGain.label}</span> was the strongest area, growing{' '}
          <span style={{ color: STATUS.good.text }}>+{biggestGain.pct}%</span>.{' '}
        </>
      ) : (
        <>Almost all metrics softened over this period.</>
      )}
    </>
  );

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <SegmentedTabs options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} value={mode} onChange={setMode} />
        <div className="flex items-center gap-2 w-full md:w-auto">
          {mode === 'month' ? (
            <>
              <input type="month" value={a} onChange={(e) => setA(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="First month" />
              <span className="text-faint text-[13px] shrink-0">vs</span>
              <input type="month" value={b} onChange={(e) => setB(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="Second month" />
            </>
          ) : (
            <>
              <input type="date" value={wA} onChange={(e) => setWA(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="First week start" />
              <span className="hidden md:inline text-[13px] text-faint">{weekLabel(wA)}</span>
              <span className="text-faint text-[13px] shrink-0">vs</span>
              <input type="date" value={wB} onChange={(e) => setWB(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="Second week start" />
              <span className="hidden md:inline text-[13px] text-faint">{weekLabel(wB)}</span>
            </>
          )}
        </div>
        <span className="ml-auto hidden md:inline-flex"><Badge tone={overall.tone} dot>{overall.t}</Badge></span>
      </PageToolbar>

      {error && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">
          Unable to load this comparison right now. Try refreshing.
        </div>
      )}

      <PageIntro title={`${fmtLabel(labelB)} compared with ${fmtLabel(labelA)}`} subtitle={summary} />

      <KpiStrip cols={6} loading={!data} items={kpis} />

      {/* Biggest changes + radar */}
      <Tray className="mt-3 lg:grid-cols-[1.25fr_1fr]">
        <TrayCard title="Biggest changes" subtitle={`${fmtLabel(labelA)} vs ${fmtLabel(labelB)}, largest declines first`}>
          <div>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Metric</th>
                  <th className="num">{shortA}</th>
                  <th className="num">{shortB}</th>
                  <th className="num">Change</th>
                  <th className="num hidden sm:table-cell">Trend</th>
                </tr>
              </thead>
              <tbody>
                {!data ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((__, k) => (
                        <td key={k} className={k === 5 ? 'hidden sm:table-cell' : undefined}><div className="h-4 bg-muted rounded-control animate-pulse" /></td>
                      ))}
                    </tr>
                  ))
                ) : (
                  byDrop.map((c, i) => (
                    <tr key={c.key}>
                      <td className="rank">{i + 1}</td>
                      <td>{c.label}</td>
                      <td className="num">{c.va.toLocaleString()}</td>
                      <td className="num">{c.vb.toLocaleString()}</td>
                      <td className="num whitespace-nowrap">
                        {c.pct === 0 ? <span className="text-faint">0%</span>
                          : <span style={{ color: c.pct > 0 ? STATUS.good.text : STATUS.critical.text }}>{fmtSignedPct(c.pct)}</span>}
                      </td>
                      <td className="num hidden sm:table-cell">
                        <span className="inline-block align-middle">
                          <Sparkline data={c.spark} width={56} height={16} fill={false} dot={false}
                            color={c.pct > 0 ? STATUS.good.color : c.pct < 0 ? STATUS.critical.color : STATUS.neutral.color} />
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TrayCard>

        <TrayCard className="flex flex-col" title="Profile shape" subtitle="Each metric scaled to the larger of the two periods">
          <div className="pt-1 flex-1 flex flex-col justify-center">
            <ResponsiveContainer width="100%" height={262}>
              <RadarChart data={radar} outerRadius={66} margin={{ top: 14, right: 10, bottom: 14, left: 10 }}>
                <PolarGrid stroke={CHART.grid} />
                <PolarAngleAxis dataKey="metric" tick={AXIS_TICK} />
                <Radar name={fmtLabel(labelA)} dataKey="A" stroke={STATUS.neutral.color} fill={STATUS.neutral.color} fillOpacity={0.18} strokeWidth={1.5} />
                <Radar name={fmtLabel(labelB)} dataKey="B" stroke={CHART.highlight} fill={CHART.highlight} fillOpacity={0.14} strokeWidth={1.5} />
                <Legend wrapperStyle={{ fontSize: 12, color: CHART.text, paddingTop: 4, paddingBottom: 12 }} iconType="square" iconSize={8} />
                <Tooltip content={<CustomRadarTooltip labelA={fmtLabel(labelA)} labelB={fmtLabel(labelB)} />} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </TrayCard>
      </Tray>
    </div>
  );
}

// Tooltip for the radar chart.
function CustomRadarTooltip({ active, payload, label, labelA, labelB }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-fg text-white text-xs rounded-control px-3 py-2">
      <div className="text-[11px] text-white/60 mb-1">{label}</div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS.neutral.color }} />
            {labelA}:
          </span>
          <span className="tnum">{(payload[0].payload.va).toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: CHART.highlight }} />
            {labelB}:
          </span>
          <span className="tnum">{(payload[1].payload.vb).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
