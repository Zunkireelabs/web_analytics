import { useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import DonutChart from '../components/DonutChart.jsx';
import MoversList from '../components/MoversList.jsx';
import CountriesWidget from '../components/CountriesWidget.jsx';
import GeoIntelligenceCard from '../components/GeoIntelligenceCard.jsx';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Section from '../components/layout/Section.jsx';
import { Tray, TrayCard } from '../components/layout/Tray.jsx';
import Button from '../components/Button.jsx';
import { fmtRange } from '../lib/format.js';

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
  const [error, setError] = useState(false);
  // Geographic audience (where sessions come from, with the AI's read on it) used to sit at the bottom of
  // the Orchestration page; it belongs with the rest of the traffic data, so it lives here now.
  const [geo, setGeo] = useState(null); // null = loading
  useEffect(() => { api.commandCenter.get().then(setGeo).catch(() => setGeo({})); }, [siteId]);

  // Auto-pick the freshest finalized day as the range end.
  useEffect(() => {
    if (!siteId) return;
    api.range(siteId).then((r) => {
      setRange(r);
      const latest = r.latest_visitor || r.freshest;
      if (latest) { setEnd(latest); setStart(shiftYmd(latest, 30)); }
    }).catch(() => setError(true));
  }, [siteId]);

  useEffect(() => {
    if (!siteId) return;
    // Same overlapping-fetch guard as Overview.jsx: this effect fires once
    // with the placeholder default start/end, then again once the range
    // effect above corrects them — without discarding the stale response,
    // whichever of the two requests resolves last wins, regardless of
    // which date range is actually still selected.
    let cancelled = false;
    setError(false);
    api.series(siteId, start, end).then((s) => { if (!cancelled) setSeries(s); }).catch(() => { if (!cancelled) setError(true); });
    api.device(siteId, start, end).then((d) => { if (!cancelled) setDevice(d); }).catch(() => { if (!cancelled) setError(true); });
    api.country(siteId, start, end).then((c) => { if (!cancelled) setCountry(c); }).catch(() => { if (!cancelled) setError(true); });
    api.movers(siteId, start, end).then((m) => { if (!cancelled) setMovers(m); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [siteId, start, end]);

  const deviceData = device.map((d) => ({ name: cap(d.dim_value), value: Number(d.sessions) }));
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));
  const total = (k) => sv(k).reduce((a, b) => a + b, 0);
  // series.length === 0 alone can't tell "still loading" apart from "a real
  // fetch failure" — getDailySeries always returns one row per day
  // regardless of data presence, so a genuinely empty series only happens
  // on error. error is checked first so a real failure shows a message
  // instead of an endless loading skeleton.
  const loading = !error && series.length === 0;

  const dateInput = 'h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg min-w-0 flex-1 md:flex-none';
  const kpis = [
    { label: 'Clicks', key: 'clicks' },
    { label: 'Impressions', key: 'impressions' },
    { label: 'Users', key: 'users' },
    { label: 'Sessions', key: 'sessions' },
  ].map(({ label, key }) => ({ label, value: fmtInt(total(key)), spark: sv(key) }));

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor} aria-label="Start date"
            onChange={(e) => setStart(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} />
          <span className="text-faint shrink-0">→</span>
          <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor} aria-label="End date"
            onChange={(e) => setEnd(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} />
        </div>
        <span className="ml-auto hidden md:block text-[13px] text-faint">Compared with {moverPeriodLabel(start, end)}</span>
      </PageToolbar>

      {error && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">
          Unable to load some real data right now. Try refreshing.
        </div>
      )}

      <PageIntro
        title={loading ? 'Insights' : `${fmtInt(total('clicks'))} clicks from ${fmtInt(total('impressions'))} impressions`}
        subtitle={loading ? null : `Search queries, devices and where your visitors come from, ${fmtRange(start, end)}.`}
      />

      <KpiStrip items={kpis} loading={loading} />

      <Tray className="mt-3 lg:grid-cols-[1fr_1.5fr]">
        <TrayCard title="Devices" subtitle="Sessions by device type" source="Google Analytics">
          <DonutChart title="Visitors by Device" data={deviceData} />
        </TrayCard>
        <TrayCard title="Visitors by country" subtitle="Top 10 locations by sessions" source="Google Analytics">
          <CountryCard rows={country.visitors} barKey="sessions" />
        </TrayCard>
      </Tray>

      {/* Top countries by clicks — interactive world map + leaderboard */}
      <Section tray className="mt-3" title="Search clicks by country" subtitle="Where your search clicks come from" source="Google Search Console">
        <CountriesWidget rows={country.search} />
      </Section>

      <Tray className="mt-3" title="Geographic audience" subtitle="Where your sessions come from" source="Google Analytics">
        <GeoIntelligenceCard geoIntelligence={geo?.geoIntelligence} meta={geo?.geoIntelligenceMeta} loading={geo === null} />
      </Tray>

      {/* Detailed query movements and highlights at the bottom for analysis —
          MoversList renders its own trays. */}
      <div className="mt-3">
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
const flag = (c) => FLAG[c] || '🏳️';

// Visitors list as a ranked table; 5 rows with a "Show all" toggle.
function CountryCard({ rows, barKey }) {
  const [showAll, setShowAll] = useState(false);
  const list = rows || [];
  const max = Math.max(1, ...list.map((r) => Number(r[barKey]) || 0));
  const shown = showAll ? list : list.slice(0, 5);
  return (
    <div>
      {list.length === 0 ? (
        <div className="text-sm text-faint text-center py-10">No data.</div>
      ) : (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Country</th>
                <th className="num">Sessions</th>
                <th className="num hidden sm:table-cell">Users</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td className="rank">{i + 1}</td>
                  <td className="bar max-w-0 w-full">
                    <i style={{ width: `${Math.max((Number(r[barKey]) / max) * 100, 4)}%` }} />
                    <span className="block truncate">{flag(r.country)} {r.country}</span>
                  </td>
                  <td className="num">{Number(r.sessions).toLocaleString()}</td>
                  <td className="num hidden sm:table-cell">{Number(r.users).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tbl-foot">
            <span>Showing {shown.length} of {list.length}</span>
            {list.length > 5 && (
              <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : 'Show all'}</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
