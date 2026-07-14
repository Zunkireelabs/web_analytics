import { useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import DonutChart from '../components/DonutChart.jsx';
import MoversList from '../components/MoversList.jsx';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import CountriesWidget from '../components/CountriesWidget.jsx';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtInt = (v) => Number(v).toLocaleString();
const shiftYmd = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

// The real comparison window /movers uses is "the immediately preceding
// period of the same length" (server/routes/metrics.js) — this describes
// that real window instead of a hardcoded "last week," which was wrong
// for any range that wasn't exactly 7 days (the default here is 30).
function moverPeriodLabel(start, end) {
  const days = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days <= 1) return 'the prior day';
  if (days === 7) return 'the prior week';
  if (days >= 28 && days <= 31) return 'the prior month';
  return `the prior ${days} days`;
}

export default function Insights({ siteId }) {
  const [range, setRange] = useState(null);
  const [start, setStart] = useState(daysAgo(33));
  const [end, setEnd] = useState(daysAgo(3));
  const [series, setSeries] = useState([]);
  const [device, setDevice] = useState([]);
  const [country, setCountry] = useState({ visitors: [], search: [] });
  const [movers, setMovers] = useState({ gainers: [], droppers: [] });

  // Auto-pick the freshest finalized day as the range end.
  useEffect(() => {
    if (!siteId) return;
    api.range(siteId).then((r) => {
      setRange(r);
      const latest = r.latest_visitor || r.freshest;
      if (latest) { setEnd(latest); setStart(shiftYmd(latest, 30)); }
    }).catch(() => {});
  }, [siteId]);

  useEffect(() => {
    if (!siteId) return;
    // Same overlapping-fetch guard as Overview.jsx: this effect fires once
    // with the placeholder default start/end, then again once the range
    // effect above corrects them — without discarding the stale response,
    // whichever of the two requests resolves last wins, regardless of
    // which date range is actually still selected.
    let cancelled = false;
    api.series(siteId, start, end).then((s) => { if (!cancelled) setSeries(s); }).catch(() => {});
    api.device(siteId, start, end).then((d) => { if (!cancelled) setDevice(d); }).catch(() => {});
    api.country(siteId, start, end).then((c) => { if (!cancelled) setCountry(c); }).catch(() => {});
    api.movers(siteId, start, end).then((m) => { if (!cancelled) setMovers(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [siteId, start, end]);

  const deviceData = device.map((d) => ({ name: cap(d.dim_value), value: Number(d.sessions) }));
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));
  const total = (k) => sv(k).reduce((a, b) => a + b, 0);
  const loading = series.length === 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader title="Insights" subtitle="Top movers, devices, and geography" icon="🔍" right={<>
        <label className="text-xs text-slate-500">From<br/>
          <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
                 onChange={(e) => setStart(e.target.value)}
                 className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
        <label className="text-xs text-slate-500">To<br/>
          <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
                 onChange={(e) => setEnd(e.target.value)}
                 className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
      </>} />

      {/* Range KPI summary with sparklines */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Clicks (range)" icon="🖱" color="#6C63FF" data={sv('clicks')} value={total('clicks')} format={fmtInt} loading={loading} />
        <StatCard label="Impressions (range)" icon="👁" color="#8b5cf6" data={sv('impressions')} value={total('impressions')} format={fmtInt} loading={loading} />
        <StatCard label="Users (range)" icon="👥" color="#10b981" data={sv('users')} value={total('users')} format={fmtInt} loading={loading} />
        <StatCard label="Sessions (range)" icon="⏱" color="#14b8a6" data={sv('sessions')} value={total('sessions')} format={fmtInt} loading={loading} />
      </div>

      {/* Top movers */}
      <MoversList gainers={movers.gainers} droppers={movers.droppers} comparisonLabel={moverPeriodLabel(start, end)} />

      <div className="grid md:grid-cols-2 gap-4">
        {/* Device split */}
        <DonutChart title="Visitors by device (sessions)" data={deviceData} />

        {/* Visitors by country (GA4) */}
        <CountryCard title="Visitors by country" rows={country.visitors}
          barKey="sessions" cols={[['sessions', 'Sessions'], ['users', 'Users']]} />
      </div>

      {/* Top countries by clicks — interactive world map + leaderboard */}
      <CountriesWidget rows={country.search} />
    </div>
  );
}

const FLAG = {
  'United States': '🇺🇸', 'India': '🇮🇳', 'United Kingdom': '🇬🇧', 'Nepal': '🇳🇵', 'Canada': '🇨🇦',
  'Australia': '🇦🇺', 'Germany': '🇩🇪', 'France': '🇫🇷', 'Netherlands': '🇳🇱', 'Pakistan': '🇵🇰',
  'Bangladesh': '🇧🇩', 'Sri Lanka': '🇱🇰', 'UAE': '🇦🇪', 'Saudi Arabia': '🇸🇦', 'Singapore': '🇸🇬',
  'Malaysia': '🇲🇾', 'Indonesia': '🇮🇩', 'Philippines': '🇵🇭', 'Thailand': '🇹🇭', 'Japan': '🇯🇵',
  'China': '🇨🇳', 'South Korea': '🇰🇷', 'Russia': '🇷🇺', 'Brazil': '🇧🇷', 'Italy': '🇮🇹', 'Spain': '🇪🇸',
  'Switzerland': '🇨🇭', 'Sweden': '🇸🇪', 'Ireland': '🇮🇪', 'New Zealand': '🇳🇿', 'South Africa': '🇿🇦',
  'Turkey': '🇹🇷', 'Mexico': '🇲🇽', 'Poland': '🇵🇱', 'Vietnam': '🇻🇳', 'Hong Kong': '🇭🇰', 'Qatar': '🇶🇦',
};
const flag = (c) => FLAG[c] || '🌐';

function RankBadge({ n }) {
  const top = n <= 3;
  return (
    <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
      style={top ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' } : { background: '#f1f5f9', color: '#94a3b8' }}>
      {n}
    </span>
  );
}

// Visual ranked country list: rank badge + flag + gradient bar + value chip.
function CountryCard({ title, rows, barKey, cols }) {
  const list = rows || [];
  const max = Math.max(1, ...list.map((r) => Number(r[barKey]) || 0));
  const [primaryKey, primaryLbl] = cols[0];
  const [secKey, secLbl] = cols[1];
  return (
    <div className="card p-5 fade-up">
      <div className="flex items-center justify-between mb-3">
        <div className="card-title">{title}</div>
        <span className="text-[10px] text-slate-400 bg-slate-50 rounded-full px-2 py-0.5">Top {list.length || 0}</span>
      </div>
      {list.length === 0 && <div className="text-sm text-slate-400 py-4">No data.</div>}
      <div className="divide-y divide-slate-50">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-2.5 py-2.5">
            <RankBadge n={i + 1} />
            <span className="text-base shrink-0">{flag(r.country)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-slate-700 truncate">{r.country}</span>
                <span className="text-sm font-bold text-slate-900 shrink-0">
                  {Number(r[primaryKey]).toLocaleString()}
                  <span className="text-[10px] font-normal text-slate-400"> {primaryLbl.toLowerCase()}</span>
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 mt-1.5 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(Number(r[barKey]) / max) * 100}%`, background: 'linear-gradient(90deg,#6C63FF,#8b5cf6)' }} />
              </div>
              <div className="text-[11px] text-slate-400 mt-1.5">{secLbl}: {Number(r[secKey]).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
