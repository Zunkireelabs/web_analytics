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
    // On mount this effect fires once with the placeholder default start/end,
    // then again as soon as the range-fetch effect above corrects them —
    // two overlapping requests for two different date ranges. Without this
    // guard, whichever response lands last wins (usually the larger,
    // slower placeholder-range query), silently overwriting the correct
    // numbers with stale ones even though the date picker itself (bound
    // directly to start/end state, not to fetched data) already shows the
    // right dates. `cancelled` discards a response for a start/end that's
    // no longer current.
    let cancelled = false;
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
        if (cancelled) return;
        setSeries(s);
        setPrevSeries(ps);
        setChannels(c);
        setRangeQueries(q);
        setRangePages(p);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, start, end]);

  const anchor = range?.latest_visitor || range?.freshest || daysAgo(1);
  const setPreset = (d) => { setStart(shiftYmd(anchor, d)); setEnd(anchor); };
  const setAll = () => { if (range?.earliest) { setStart(range.earliest); setEnd(anchor); } };

  const todayRow = series.find((r) => String(r.date).slice(0, 10) === range?.latest_visitor) || {};
  const yesterdayRow = series.find((r) => String(r.date).slice(0, 10) === (range?.latest_visitor ? shiftYmd(range.latest_visitor, 1) : '')) || null;
  const sv = (k) => series.map((r) => Number(r[k] ?? 0));
  // Position is the one metric where 0 is never a real value (ranks start
  // at 1) and a day with no finalized GSC data legitimately has no
  // position yet — `?? 0` above would render that as rank #0, the single
  // best point on a "lower is better" chart, exactly backwards. Leaving it
  // `undefined` lets Sparkline's own `Number.isFinite` filter drop the
  // point instead of plotting a fabricated "perfect" day.
  const svPosition = () => series.map((r) => (r.position != null ? Number(r.position) : undefined));

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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 relative font-sans fade-up">

      {/* Decorative Glows */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[145px] bg-indigo-500/10 opacity-50 pulse-glow" />
        <div className="absolute bottom-10 left-1/4 w-[500px] h-[500px] rounded-full blur-[125px] bg-purple-500/8 opacity-45 pulse-glow" />
        <div className="absolute top-1/2 left-1/3 w-[300px] h-[300px] rounded-full blur-[100px] bg-sky-500/5 opacity-30 pulse-glow" />
      </div>

      {/* Page Header + Compact Date Selector combined */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2">
        <PageHeader title="Overview" subtitle="Search performance & visitor analytics summary" icon="📊" />
        
        {/* Date presets and pickers in a modern glass bar. The two groups
            below stretch full-width and their items share the row equally
            on mobile (w-full + flex-1) — left content-sized on its own, they
            left the rest of this full-width card empty on the right. */}
        <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm p-3 rounded-2xl flex flex-wrap items-center gap-3 z-10">
          <div className="flex w-full sm:w-auto bg-slate-100/70 p-0.5 rounded-xl border border-slate-200/30">
            {[3, 7, 14, 30].map((d) => (
              <button key={d} onClick={() => setPreset(d)}
                className={`flex-1 sm:flex-none text-center text-[10px] font-bold px-3 py-1.5 rounded-lg transition ${
                  start === shiftYmd(anchor, d) && end === anchor
                    ? 'bg-white text-indigo-600 shadow-sm active-pill-shadow'
                    : 'text-slate-500 hover:text-slate-800'
                }`}>
                {d}d
              </button>
            ))}
            <button onClick={setAll}
              className={`flex-1 sm:flex-none text-center text-[10px] font-bold px-3 py-1.5 rounded-lg transition ${
                range && start === range.earliest && end === anchor
                  ? 'bg-white text-indigo-600 shadow-sm active-pill-shadow'
                  : 'text-slate-500 hover:text-slate-800'
              }`}>
              All
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs w-full sm:w-auto">
            <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
              onChange={(e) => setStart(e.target.value)}
              className="flex-1 sm:flex-none bg-white border border-slate-200/80 rounded-xl px-2.5 py-1 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm min-w-0 sm:w-[115px]" />
            <span className="text-slate-400 font-bold shrink-0">→</span>
            <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
              onChange={(e) => setEnd(e.target.value)}
              className="flex-1 sm:flex-none bg-white border border-slate-200/80 rounded-xl px-2.5 py-1 text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition shadow-sm min-w-0 sm:w-[115px]" />
          </div>
        </div>
      </div>

      {range?.earliest && (
        // The dot and the text must be exactly 2 flex items, not one flex
        // item per text run — `flex` on a mix of bare text + inline spans
        // makes each text run its own anonymous flex item, which shrinks/
        // wraps independently of its neighbors instead of as one paragraph.
        // That was splitting "Data through" from its date and even
        // mid-word ("2026-07-" / "17") on mobile. Wrapping it all in one
        // span makes it flow as normal text again.
        <p className="text-[10px] font-bold text-slate-400 -mt-4 pl-1.5 flex items-start gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/60 mt-1 shrink-0" />
          <span>
            Data through <span className="text-slate-600">{range.latest_visitor}</span> · Search finalized through <span className="text-slate-600">{range.freshest}</span>.
          </span>
        </p>
      )}

      {/* Today so far — live visitors alert panel */}
      {range?.latest_visitor && (
        <div className="bg-emerald-500/[0.02] border border-emerald-500/10 backdrop-blur-md rounded-2xl p-3.5 flex flex-wrap items-center gap-4 shadow-sm">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full select-none shrink-0 shadow-sm shadow-emerald-500/5">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
            </span>
            Live Activity
          </span>

          {/* w-full + flex-1 pills: on mobile these two used to sit at their
              natural (narrow) width, leaving a big dead gap on the right of
              this full-width card. Stretching them to share the row evenly
              fills it; sm+ reverts to natural width since there's more room. */}
          <div className="flex flex-wrap gap-3 items-center text-xs font-semibold w-full sm:w-auto">
            <span className="flex-1 sm:flex-none justify-center sm:justify-start text-slate-600 bg-white border border-slate-100 shadow-sm rounded-xl px-3 py-1.5 flex items-center gap-1.5">
              🚀 <strong className="text-slate-900 font-black">{fmtInt(todayRow.users ?? 0)}</strong> users
              {yesterdayRow && (() => {
                const delta = (todayRow.users ?? 0) - (yesterdayRow.users ?? 0);
                return <span className={`ml-1 font-bold flex items-center gap-0.5 ${delta >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{delta >= 0 ? '▲' : '▼'} {fmtInt(Math.abs(delta))} <span className="text-[10px] text-slate-400 font-medium">vs yesterday</span></span>;
              })()}
            </span>

            <span className="flex-1 sm:flex-none justify-center sm:justify-start text-slate-600 bg-white border border-slate-100 shadow-sm rounded-xl px-3 py-1.5 flex items-center gap-1.5">
              ⏱ <strong className="text-slate-900 font-black">{fmtInt(todayRow.sessions ?? 0)}</strong> sessions
              {yesterdayRow && (() => {
                const delta = (todayRow.sessions ?? 0) - (yesterdayRow.sessions ?? 0);
                return <span className={`ml-1 font-bold flex items-center gap-0.5 ${delta >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{delta >= 0 ? '▲' : '▼'} {fmtInt(Math.abs(delta))} <span className="text-[10px] text-slate-400 font-medium">vs yesterday</span></span>;
              })()}
            </span>
          </div>

          <span className="text-[10px] font-bold text-slate-400 sm:ml-auto uppercase tracking-wide">
            GA4 Realtime Synced
          </span>
        </div>
      )}

      {/* Hero Performance Dashboard Block: Trend Chart + primary metrics side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-8 flex flex-col">
          <PerformanceTrendCard series={series} loading={loading} />
        </div>
        {/* Always 2 columns (even below sm) — 4 cards stacked one-per-row was
            a lot of vertical scroll on a phone for what's just 4 numbers. */}
        <div className="lg:col-span-4 grid grid-cols-2 gap-3 sm:gap-4">
          <KpiCard icon={BarChart3} iconBg="rgba(108,99,255,0.08)" iconColor="#6C63FF"
            label="Impressions" value={fmtInt(pm.impressions)}
            badge={badgeFor(pm.impressions, pmp.impressions)} sub={compareLabel} loading={loading} />
          <KpiCard icon={MousePointerClick} iconBg="rgba(139,92,246,0.08)" iconColor="#8b5cf6"
            label="Clicks" value={fmtInt(pm.clicks)}
            badge={badgeFor(pm.clicks, pmp.clicks)} sub={compareLabel} loading={loading} />
          <KpiCard icon={Percent} iconBg="rgba(14,165,233,0.08)" iconColor="#0ea5e9"
            label="Average CTR" value={`${(pm.ctr * 100).toFixed(2)}%`}
            badge={badgeFor(pm.ctr, pmp.ctr)} sub={compareLabel} loading={loading} />
          <KpiCard icon={Share2} iconBg="rgba(16,185,129,0.08)" iconColor="#10b981"
            label="Top Channel" value={topChannelRow?.channel || '—'}
            badge={totalSessions ? { text: `${topChannelShare}%`, tone: 'neutral' } : null}
            sub="of total sessions" loading={loading} />
        </div>
      </div>

      {/* Secondary metrics: search position + GA4 audience. Always 2 cols
          (even below sm) — 4 cards stacked one-per-row was a lot of vertical
          scroll on a phone for what's just 4 numbers with sparklines. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5">
        <StatCard label="Avg position" hint="lower is better" icon="🏅" color="#f59e0b" data={svPosition()} value={pm.position} prev={pmp.position} lowerIsBetter format={fmtFloat} loading={loading} />
        <StatCard label="Users" icon="👥" color="#10b981" data={sv('users')} value={pm.users} prev={pmp.users} format={fmtInt} loading={loading} />
        <StatCard label="Sessions" icon="⏱" color="#14b8a6" data={sv('sessions')} value={pm.sessions} prev={pmp.sessions} format={fmtInt} loading={loading} />
        <StatCard label="Conversions" icon="✅" color="#d946ef" data={sv('conversions')} value={pm.conversions} prev={pmp.conversions} format={fmtInt} loading={loading} />
      </div>

      {/* Bento grid row 1: Top Pages (60%) · Quick Insights (40%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-stretch">
        <TopPagesCard pages={rangePages} loading={loading} />
        <AiInsightsPanel channels={channels} queries={rangeQueries} pages={rangePages} loading={loading} />
      </div>

      {/* Bento grid row 2: Top Queries (65%) · Traffic Distribution (35%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[13fr_7fr] gap-6 items-stretch">
        <TopQueriesCard queries={rangeQueries} loading={loading} />
        <TrafficDistributionCard channels={channels} loading={loading} />
      </div>

      {loading && <div className="text-xs font-bold text-slate-400 text-center animate-pulse py-4">Syncing live site workspace metrics...</div>}
    </div>
  );
}
