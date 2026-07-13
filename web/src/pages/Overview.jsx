import { useEffect, useState } from 'react';
import { BarChart3, MousePointerClick, Percent, Share2 } from 'lucide-react';
import { api, daysAgo } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import KpiCard from '../components/KpiCard.jsx';
import TopQueriesCard from '../components/TopQueriesCard.jsx';
import TrafficDistributionCard from '../components/TrafficDistributionCard.jsx';
import AiInsightsPanel from '../components/AiInsightsPanel.jsx';
import TopPagesCard from '../components/TopPagesCard.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import PageHeader from '../components/PageHeader.jsx';

const fmtInt = (v) => Number(v).toLocaleString();
const fmtFloat = (v) => Number(v).toFixed(1);

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Relative % change, rounded to 1 decimal. Null when there's no prior baseline.
function pctDelta(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export default function Overview({ siteId }) {
  const [range, setRange] = useState(null);
  const [start, setStart] = useState(daysAgo(33));
  const [end, setEnd] = useState(daysAgo(3));
  const [series, setSeries] = useState([]);
  const [prevSeries, setPrevSeries] = useState([]);
  const [channels, setChannels] = useState([]);
  const [rangeQueries, setRangeQueries] = useState([]);
  const [rangePages, setRangePages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!siteId) return;
    api.range(siteId).then((r) => {
      setRange(r);
      const latest = r.latest_visitor || r.freshest;
      if (r.freshest) {
        setEnd(latest);
        setStart(shiftYmd(latest, 3));
      }
    }).catch(() => {});
  }, [siteId]);

  useEffect(() => {
    if (!siteId) return;
    setLoading(true);
    const rangeLen = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000);
    const priorEnd = shiftYmd(start, 1);
    const priorStart = shiftYmd(priorEnd, rangeLen);
    Promise.all([
      api.series(siteId, start, end),
      api.series(siteId, priorStart, priorEnd),
      api.channels(siteId, start, end),
      api.breakdownRange(siteId, start, end, 'query', 10),
      api.breakdownRange(siteId, start, end, 'page', 10),
    ])
      .then(([s, ps, c, q, p]) => {
        setSeries(s);
        setPrevSeries(ps);
        setChannels(c);
        setRangeQueries(q);
        setRangePages(p);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [siteId, start, end]);

  const anchor = range?.latest_visitor || range?.freshest || daysAgo(1);
  const setPreset = (d) => { setStart(shiftYmd(anchor, d)); setEnd(anchor); };
  const setAll = () => { if (range?.earliest) { setStart(range.earliest); setEnd(anchor); } };

  const todayRow = series.find((r) => String(r.date).slice(0, 10) === range?.latest_visitor) || {};
  const yesterdayRow = series.find((r) => String(r.date).slice(0, 10) === (range?.latest_visitor ? shiftYmd(range.latest_visitor, 1) : '')) || null;
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));

  const pSum = (arr, k) => arr.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const posAvg = (arr) => {
    const rows = arr.filter((r) => r.position != null && r.impressions != null);
    const sumImpr = rows.reduce((a, r) => a + Number(r.impressions), 0);
    return sumImpr > 0 ? rows.reduce((a, r) => a + Number(r.position) * Number(r.impressions), 0) / sumImpr : null;
  };

  const curImpr = pSum(series, 'impressions');
  const prvImpr = pSum(prevSeries, 'impressions');

  const pm = {
    clicks: pSum(series, 'clicks'),
    impressions: curImpr,
    ctr: curImpr > 0 ? pSum(series, 'clicks') / curImpr : 0,
    position: posAvg(series),
    users: pSum(series, 'users'),
    sessions: pSum(series, 'sessions'),
    conversions: pSum(series, 'conversions'),
  };

  const pmp = {
    clicks: pSum(prevSeries, 'clicks'),
    impressions: prvImpr,
    ctr: prvImpr > 0 ? pSum(prevSeries, 'clicks') / prvImpr : 0,
    position: posAvg(prevSeries),
    users: pSum(prevSeries, 'users'),
    sessions: pSum(prevSeries, 'sessions'),
    conversions: pSum(prevSeries, 'conversions'),
  };

  const rangeLen = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000);
  const priorEnd = shiftYmd(start, 1);
  const priorStart = shiftYmd(priorEnd, rangeLen);
  const compareLabel = `vs ${priorStart} → ${priorEnd}`;

  const totalSessions = channels.reduce((a, c) => a + Number(c.sessions || 0), 0);
  const topChannelRow = [...channels].sort((a, b) => Number(b.sessions) - Number(a.sessions))[0];
  const topChannelShare = topChannelRow && totalSessions ? Math.round((Number(topChannelRow.sessions) / totalSessions) * 100) : 0;

  const badgeFor = (cur, prev, lowerIsBetter = false) => {
    const d = pctDelta(cur, prev);
    if (d == null || d === 0) return null;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return { text: `${Math.abs(d)}%`, tone: good ? 'up' : 'down' };
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 relative font-sans">

      {/* Decorative Glows */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[140px] bg-indigo-500/5 opacity-45" />
        <div className="absolute bottom-10 left-1/4 w-[500px] h-[500px] rounded-full blur-[120px] bg-purple-500/5 opacity-40" />
      </div>

      {/* Page Header */}
      <PageHeader title="Overview" subtitle="Search performance summary" icon="📊" />

      {/* Today so far — live visitors alert panel */}
      {range?.latest_visitor && (
        <div className="bg-emerald-500/5 border border-emerald-500/10 backdrop-blur-md rounded-2xl p-4 flex flex-wrap items-center gap-4 shadow-sm">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 bg-emerald-500/10 px-3 py-1 rounded-full select-none shrink-0">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
            </span>
            Live Activity
          </span>

          <div className="flex flex-wrap gap-3 items-center text-xs">
            <span className="text-slate-600 font-medium bg-white border border-slate-100/80 rounded-xl px-3 py-1.5">
              🚀 <strong className="text-slate-800 font-bold">{fmtInt(todayRow.users ?? 0)}</strong> users
              {yesterdayRow && (() => {
                const delta = (todayRow.users ?? 0) - (yesterdayRow.users ?? 0);
                return <span className={`ml-1.5 font-bold ${delta >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{delta >= 0 ? '▲' : '▼'} {fmtInt(Math.abs(delta))} yesterday</span>;
              })()}
            </span>

            <span className="text-slate-600 font-medium bg-white border border-slate-100/80 rounded-xl px-3 py-1.5">
              ⏱ <strong className="text-slate-800 font-bold">{fmtInt(todayRow.sessions ?? 0)}</strong> sessions
              {yesterdayRow && (() => {
                const delta = (todayRow.sessions ?? 0) - (yesterdayRow.sessions ?? 0);
                return <span className={`ml-1.5 font-bold ${delta >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{delta >= 0 ? '▲' : '▼'} {fmtInt(Math.abs(delta))} yesterday</span>;
              })()}
            </span>
          </div>

          <span className="text-[11px] text-slate-400 sm:ml-auto">
            GSC search traffic finalizes in ~3 days · live audience synced from GA4
          </span>
        </div>
      )}

      {/* Date controls and selectors */}
      <div className="bg-white border border-slate-100/80 shadow-sm p-4 rounded-3xl flex flex-wrap items-center gap-4 z-10 relative">
        <div className="flex bg-slate-100/80 p-1 rounded-2xl border border-slate-200/30">
          {[3, 7, 14, 30].map((d) => (
            <button key={d} onClick={() => setPreset(d)}
              className={`text-xs px-3.5 py-1.5 font-semibold rounded-xl transition ${
                start === shiftYmd(anchor, d) && end === anchor
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-600/10'
                  : 'text-slate-600 hover:bg-white/50 hover:text-slate-800'
              }`}>
              {d}d
            </button>
          ))}
          <button onClick={setAll}
            className={`text-xs px-3.5 py-1.5 font-semibold rounded-xl transition ${
              range && start === range.earliest && end === anchor
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-600/10'
                : 'text-slate-600 hover:bg-white/50 hover:text-slate-800'
            }`}>
            All Time
          </button>
        </div>

        <div className="flex items-center gap-3 ml-auto flex-wrap text-xs text-slate-400">
          <label className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">From</span>
            <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
              onChange={(e) => setStart(e.target.value)}
              className="bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition" />
          </label>

          <label className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">To</span>
            <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
              onChange={(e) => setEnd(e.target.value)}
              className="bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition" />
          </label>

        </div>
      </div>

      {range?.earliest && (
        <p className="text-[11px] text-slate-400 -mt-2 pl-1">
          Charts run through <strong className="text-slate-500">{range.latest_visitor}</strong> (visitors) · search finalized through <strong className="text-slate-500">{range.freshest}</strong>.
        </p>
      )}

      {/* Hero KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={BarChart3} iconBg="rgba(108,99,255,0.1)" iconColor="#6C63FF"
          label="Total Impressions" value={fmtInt(pm.impressions)}
          badge={badgeFor(pm.impressions, pmp.impressions)} sub={compareLabel} loading={loading} />
        <KpiCard icon={MousePointerClick} iconBg="rgba(139,92,246,0.1)" iconColor="#8b5cf6"
          label="Total Clicks" value={fmtInt(pm.clicks)}
          badge={badgeFor(pm.clicks, pmp.clicks)} sub={compareLabel} loading={loading} />
        <KpiCard icon={Percent} iconBg="rgba(14,165,233,0.1)" iconColor="#0ea5e9"
          label="Average CTR" value={`${(pm.ctr * 100).toFixed(2)}%`}
          badge={badgeFor(pm.ctr, pmp.ctr)} sub={compareLabel} loading={loading} />
        <KpiCard icon={Share2} iconBg="rgba(16,185,129,0.1)" iconColor="#10b981"
          label="Top Channel" value={topChannelRow?.channel || '—'}
          badge={totalSessions ? { text: `${topChannelShare}%`, tone: 'neutral' } : null}
          sub="of total sessions" loading={loading} />
      </div>

      {/* Secondary metrics: search position + GA4 audience */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Avg position" hint="lower is better" icon="🏅" color="#f59e0b" data={sv('position')} value={pm.position} prev={pmp.position} lowerIsBetter format={fmtFloat} loading={loading} />
        <StatCard label="Users" icon="👥" color="#10b981" data={sv('users')} value={pm.users} prev={pmp.users} format={fmtInt} loading={loading} />
        <StatCard label="Sessions" icon="⏱" color="#14b8a6" data={sv('sessions')} value={pm.sessions} prev={pmp.sessions} format={fmtInt} loading={loading} />
        <StatCard label="Conversions" icon="✅" color="#d946ef" data={sv('conversions')} value={pm.conversions} prev={pmp.conversions} format={fmtInt} loading={loading} />
      </div>

      {/* Bento row: Top Queries (55%) · Traffic Distribution (25%) · AI Insights (20%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[11fr_5fr_4fr] gap-6 items-stretch">
        <TopQueriesCard queries={rangeQueries} loading={loading} />
        <TrafficDistributionCard channels={channels} loading={loading} />
        <AiInsightsPanel channels={channels} queries={rangeQueries} pages={rangePages} loading={loading} />
      </div>

      {/* Bento row: Top Pages (60%) · Performance Trend (40%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-stretch">
        <TopPagesCard pages={rangePages} loading={loading} />
        <PerformanceTrendCard series={series} loading={loading} />
      </div>

      {loading && <div className="text-xs text-slate-400 text-center animate-pulse">Fetching live workspace metrics...</div>}
    </div>
  );
}
