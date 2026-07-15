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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 fade-up">
      <PageHeader 
        title="Insights" 
        subtitle="Deep dive into search query movements, devices, and user geography" 
        icon="🔍" 
        right={
          <div className="flex items-center gap-3 bg-white/80 border border-slate-200/50 backdrop-blur-md p-3 rounded-2xl shadow-sm z-10">
            <label className="flex flex-col">
              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-wider mb-1 px-1">From</span>
              <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
                     onChange={(e) => setStart(e.target.value)}
                     className="bg-white border border-slate-200/80 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition shadow-sm" />
            </label>
            <label className="flex flex-col">
              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-wider mb-1 px-1">To</span>
              <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
                     onChange={(e) => setEnd(e.target.value)}
                     className="bg-white border border-slate-200/80 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition shadow-sm" />
            </label>
          </div>
        } 
      />

      {/* Range KPI summary with sparklines */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        <StatCard label="Clicks (range)" icon="🖱" color="#6C63FF" data={sv('clicks')} value={total('clicks')} format={fmtInt} loading={loading} />
        <StatCard label="Impressions (range)" icon="👁" color="#8b5cf6" data={sv('impressions')} value={total('impressions')} format={fmtInt} loading={loading} />
        <StatCard label="Users (range)" icon="👥" color="#10b981" data={sv('users')} value={total('users')} format={fmtInt} loading={loading} />
        <StatCard label="Sessions (range)" icon="⏱" color="#14b8a6" data={sv('sessions')} value={total('sessions')} format={fmtInt} loading={loading} />
      </div>

      {/* Demographics & Devices Split Grid - prioritized visuals first */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-5 flex flex-col">
          <DonutChart title="Visitors by Device" data={deviceData} />
        </div>
        <div className="lg:col-span-7 flex flex-col">
          <CountryCard title="Visitors by Country" rows={country.visitors}
            barKey="sessions" cols={[['sessions', 'Sessions'], ['users', 'Users']]} />
        </div>
      </div>

      {/* Top countries by clicks — interactive world map + leaderboard */}
      <CountriesWidget rows={country.search} />

      {/* Detailed query movements and highlights section at the bottom for analysis */}
      <div className="pt-2">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">Query Movement Analysis</h2>
          <p className="text-xs text-slate-400 font-medium">Track search terms gaining or losing visibility</p>
        </div>
        <MoversList gainers={movers.gainers} droppers={movers.droppers} comparisonLabel={moverPeriodLabel(start, end)} />
      </div>
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
    <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-extrabold shrink-0"
      style={top ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff', boxShadow: '0 3px 6px -1.5px rgba(108, 99, 255, 0.3)' } : { background: '#f1f5f9', color: '#64748b' }}>
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
    <div className="card p-6 flex flex-col justify-between flex-1 fade-up">
      <div>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">{title}</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Top visitor locations ranked by session count</p>
          </div>
          <span className="text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100/80 border border-slate-200/30 text-slate-500">
            Top {list.length || 0}
          </span>
        </div>
        {list.length === 0 && <div className="text-sm text-slate-400 py-10 text-center font-medium">No data.</div>}
        <div className="divide-y divide-slate-100/50">
          {list.map((r, i) => (
            <div key={i} className="flex items-center gap-3 py-3 hover:bg-slate-50/50 rounded-xl px-1 transition duration-150 group">
              <RankBadge n={i + 1} />
              <span className="text-lg shrink-0 select-none">{flag(r.country)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-700 truncate group-hover:text-slate-900 transition-colors">{r.country}</span>
                  <span className="text-sm font-bold text-slate-900 shrink-0">
                    {Number(r[primaryKey]).toLocaleString()}
                    <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide"> {primaryLbl.toLowerCase()}</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100/80 mt-2 overflow-hidden w-full">
                  <div 
                    className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-[#6C63FF] to-[#8b5cf6]" 
                    style={{ width: `${(Number(r[barKey]) / max) * 100}%` }} 
                  />
                </div>
                <div className="text-[10px] text-slate-400 font-semibold mt-2">{secLbl}: <span className="text-slate-600 font-bold">{Number(r[secKey]).toLocaleString()}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
