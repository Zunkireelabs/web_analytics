import { useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import TrendChart from '../components/TrendChart.jsx';
import NarrativePanel from '../components/NarrativePanel.jsx';
import PerformanceSection from '../components/PerformanceSection.jsx';
import AiPanel from '../components/AiPanel.jsx';
import PageHeader from '../components/PageHeader.jsx';

const fmtInt = (v) => Number(v).toLocaleString();
const fmtFloat = (v) => Number(v).toFixed(1);

// Subtract `days` from a YYYY-MM-DD anchor, returning YYYY-MM-DD.
function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function Overview({ siteId }) {
  const [range, setRange] = useState(null); // { earliest, freshest, latest_visitor }
  const [start, setStart] = useState(daysAgo(33));
  const [end, setEnd] = useState(daysAgo(3));
  const [reportDate, setReportDate] = useState(daysAgo(3));
  const [series, setSeries] = useState([]);
  const [day, setDay] = useState(null);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);

  // On site change, learn the data range and auto-pick the freshest complete day.
  useEffect(() => {
    if (!siteId) return;
    api.range(siteId).then((r) => {
      setRange(r);
      const latest = r.latest_visitor || r.freshest;
      if (r.freshest) {
        setReportDate(r.freshest);   // headline cards = freshest FINALIZED day
        setEnd(latest);              // charts run through today's visitors
        setStart(shiftYmd(latest, 7)); // default to the 7-day view
      }
    }).catch(() => {});
  }, [siteId]);

  useEffect(() => {
    if (!siteId) return;
    setLoading(true);
    Promise.all([api.series(siteId, start, end), api.day(siteId, reportDate), api.channels(siteId, start, end)])
      .then(([s, d, c]) => { setSeries(s); setDay(d); setChannels(c); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [siteId, start, end, reportDate]);

  // Presets run up to the latest day we have data (today's visitors), not the search cutoff.
  const anchor = range?.latest_visitor || range?.freshest || daysAgo(1);
  const setPreset = (d) => { setStart(shiftYmd(anchor, d)); setEnd(anchor); };
  const setAll = () => { if (range?.earliest) { setStart(range.earliest); setEnd(anchor); } };

  // Previous-day metrics for delta arrows (the row before reportDate in the series).
  const idx = series.findIndex((r) => String(r.date).slice(0, 10) === reportDate);
  const prev = idx > 0 ? series[idx - 1] : {};
  const m = day?.metrics || {};
  // Today's live row (latest visitor day) for the "Today so far" strip.
  const todayRow = series.find((r) => String(r.date).slice(0, 10) === range?.latest_visitor) || {};
  // Per-metric arrays for the KPI mini-sparklines.
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader title="Overview" subtitle="Your daily search & audience performance" icon="📊" />
      {/* Today so far — live visitors (search not available for ~3 days) */}
      {range?.latest_visitor && (
        <div className="card p-3.5 flex flex-wrap items-center gap-3"
          style={{ background: 'linear-gradient(90deg, rgba(16,185,129,0.07), #fff 40%)' }}>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
            </span>
            Today so far
          </span>
          <span className="text-sm bg-white border border-slate-100 rounded-lg px-2.5 py-1 text-slate-700">
            <strong className="text-slate-900">{fmtInt(todayRow.users ?? 0)}</strong> users
          </span>
          <span className="text-sm bg-white border border-slate-100 rounded-lg px-2.5 py-1 text-slate-700">
            <strong className="text-slate-900">{fmtInt(todayRow.sessions ?? 0)}</strong> sessions
          </span>
          <span className="text-xs text-slate-400 ml-auto">
            {range.latest_visitor} · visitors update live · search finalizes in ~3 days
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="card p-4 flex flex-wrap items-end gap-3">
        <div className="flex gap-1 mr-2">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setPreset(d)}
              className={`text-xs px-2.5 py-1.5 rounded-lg border ${
                start === shiftYmd(anchor, d) && end === anchor
                  ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}>
              {d}d
            </button>
          ))}
          <button onClick={setAll}
            className={`text-xs px-2.5 py-1.5 rounded-lg border ${
              range && start === range.earliest && end === anchor
                ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}>
            All
          </button>
        </div>
        <label className="text-xs text-gray-500">
          From<br />
          <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
            onChange={(e) => setStart(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">
          To<br />
          <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
            onChange={(e) => setEnd(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500 ml-auto">
          Report day<br />
          <input type="date" value={reportDate} min={range?.earliest} max={range?.latest_visitor}
            onChange={(e) => setReportDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
      </div>

      {range?.earliest && (
        <p className="text-xs text-slate-400 -mt-3">
          Charts run through <strong>{range.latest_visitor}</strong> (visitors, incl. today — still updating) ·
          search finalized through <strong>{range.freshest}</strong>. Headline cards use the freshest finalized day.
        </p>
      )}

      {/* KPI cards — grouped: Search vs Visitors, each with a freshness tag */}
      <div className="space-y-4">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold text-slate-600">🔍 Search performance</span>
            <span className="text-[11px] text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">final · {reportDate}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Clicks" icon="🖱" color="#6C63FF" data={sv('clicks')} value={m.clicks} prev={prev.clicks} format={fmtInt} loading={loading} />
            <StatCard label="Impressions" icon="👁" color="#8b5cf6" data={sv('impressions')} value={m.impressions} prev={prev.impressions} format={fmtInt} loading={loading} />
            <StatCard label="CTR" icon="🎯" color="#0ea5e9" data={sv('ctr')} value={m.ctr} prev={prev.ctr} format={(v) => `${(Number(v) * 100).toFixed(2)}%`} loading={loading} />
            <StatCard label="Avg position" hint="lower is better" icon="🏅" color="#f59e0b" data={sv('position')} value={m.position} prev={prev.position} lowerIsBetter format={fmtFloat} loading={loading} />
          </div>
        </section>
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold text-slate-600">👥 Visitors</span>
            <span className="text-[11px] text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">{reportDate}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard label="Users" icon="👥" color="#10b981" data={sv('users')} value={m.users} prev={prev.users} format={fmtInt} loading={loading} />
            <StatCard label="Sessions" icon="⏱" color="#14b8a6" data={sv('sessions')} value={m.sessions} prev={prev.sessions} format={fmtInt} loading={loading} />
            <StatCard label="Conversions" icon="✅" color="#d946ef" data={sv('conversions')} value={m.conversions} prev={prev.conversions} format={fmtInt} loading={loading} />
          </div>
        </section>
      </div>

      <NarrativePanel date={reportDate} text={day?.narrative} />
      <AiPanel siteId={siteId} date={reportDate} />

      {/* Trends */}
      <div className="grid md:grid-cols-2 gap-4">
        <TrendChart title="Search: clicks & impressions" data={series}
          lines={[
            { key: 'impressions', name: 'Impressions', color: '#534AB7', axis: 'left' },
            { key: 'clicks', name: 'Clicks', color: '#D85A30', axis: 'right' },
          ]} />
        <TrendChart title="Audience: users & sessions" data={series}
          lines={[
            { key: 'users', name: 'Users', color: '#1D9E75', dash: true, gradient: ['#0ea5e9', '#22d3ee'] },
            { key: 'sessions', name: 'Sessions', color: '#1D9E75', gradient: ['#10b981', '#34d399'] },
          ]} />
      </div>

      {/* Premium SEO-intelligence section: bento grid (overview · queries · traffic · pages) */}
      <PerformanceSection day={day ? { ...day, channels } : null} series={series} reportDate={reportDate} loading={loading} />


      {loading && <div className="text-sm text-gray-400">Loading…</div>}
    </div>
  );
}
