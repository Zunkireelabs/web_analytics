import { useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import TopQueriesCard from '../components/TopQueriesCard.jsx';
import TrafficDistributionCard from '../components/TrafficDistributionCard.jsx';
import AiInsightsPanel from '../components/AiInsightsPanel.jsx';
import TopPagesCard from '../components/TopPagesCard.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import { STATUS } from '../lib/palette.js';
import { fmtDay, fmtRange, fmtSignedPct } from '../lib/format.js';

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
  const [rangeReady, setRangeReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    setRangeReady(false);
    setError(false);
    api.range(siteId).then((r) => {
      setRange(r);
      const latest = r.latest_visitor || r.freshest;
      if (r.freshest) {
        setEnd(latest);
        setStart(shiftYmd(latest, 3));
      }
    }).catch(() => setError(true)).finally(() => setRangeReady(true));
  }, [siteId]);

  useEffect(() => {
    // Wait for the range-fetch effect above to resolve the real start/end
    // before fetching data — otherwise this fires once with the placeholder
    // default dates and again with the corrected ones, wasting a full
    // 5-request round-trip on every load.
    if (!siteId || !rangeReady) return;
    setLoading(true);
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
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, start, end, rangeReady]);

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

  const totalSessions = channels.reduce((a, c) => a + Number(c.sessions || 0), 0);
  const topChannelRow = [...channels].sort((a, b) => Number(b.sessions) - Number(a.sessions))[0];
  const topChannelShare = topChannelRow && totalSessions ? Math.round((Number(topChannelRow.sessions) / totalSessions) * 100) : 0;

  // Delta pill for a KPI: good/bad by direction (inverted when lower is better),
  // omitted when there is no prior baseline or no change.
  const deltaFor = (cur, prev, lowerIsBetter = false) => {
    const d = pctDelta(cur, prev);
    if (d == null || d === 0) return undefined;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return { text: fmtSignedPct(d), tone: good ? 'good' : 'bad' };
  };

  const vsPrior = `vs ${fmtRange(priorStart, priorEnd)}`;

  // Today-vs-yesterday (the old Live Activity strip) lives in the Users and
  // Sessions subs when the site has a latest-visitor day.
  const liveSub = (key) => {
    if (!range?.latest_visitor) return vsPrior;
    const today = todayRow[key] ?? 0;
    if (!yesterdayRow) return `Today ${fmtInt(today)}`;
    const delta = today - (yesterdayRow[key] ?? 0);
    return (
      <>
        Today {fmtInt(today)} ·{' '}
        <span style={{ color: delta >= 0 ? STATUS.good.text : STATUS.critical.text }}>
          {delta >= 0 ? '+' : '\u2212'}{fmtInt(Math.abs(delta))}
        </span>{' '}
        vs yesterday
      </>
    );
  };

  const impressionsDelta = pctDelta(pm.impressions, pmp.impressions);
  const introTitle = loading ? 'Overview'
    : impressionsDelta == null ? 'Search performance for this period'
    : Math.abs(impressionsDelta) < 1 ? 'Impressions are steady in this period'
    : `Impressions are ${impressionsDelta > 0 ? 'up' : 'down'} ${Math.round(Math.abs(impressionsDelta))}% in this period`;
  const introSubtitle = loading ? null
    : `${fmtInt(pm.impressions)} impressions and ${fmtInt(pm.clicks)} clicks from ${fmtRange(start, end)}.${topChannelRow ? ` Most visits came from ${topChannelRow.channel}.` : ''}`;

  const kpis = [
    { label: 'Impressions', value: fmtInt(pm.impressions), delta: deltaFor(pm.impressions, pmp.impressions), sub: vsPrior },
    { label: 'Clicks', value: fmtInt(pm.clicks), delta: deltaFor(pm.clicks, pmp.clicks), sub: vsPrior },
    { label: 'Average CTR', value: `${(pm.ctr * 100).toFixed(2)}%`, delta: deltaFor(pm.ctr, pmp.ctr), sub: vsPrior },
    { label: 'Top channel', value: topChannelRow?.channel || '—',
      delta: totalSessions ? { text: `${topChannelShare}%`, tone: 'neutral' } : undefined, sub: 'of sessions' },
    { label: 'Avg position', value: pm.position == null ? '—' : fmtFloat(pm.position),
      delta: deltaFor(pm.position, pmp.position, true), sub: 'lower is better' },
    { label: 'Users', value: fmtInt(pm.users), delta: deltaFor(pm.users, pmp.users), sub: liveSub('users') },
    { label: 'Sessions', value: fmtInt(pm.sessions), delta: deltaFor(pm.sessions, pmp.sessions), sub: liveSub('sessions') },
    { label: 'Conversions', value: fmtInt(pm.conversions), delta: deltaFor(pm.conversions, pmp.conversions), sub: vsPrior },
  ];

  const presetOn = (d) => start === shiftYmd(anchor, d) && end === anchor;
  const allOn = range && start === range.earliest && end === anchor;
  const dateInput = 'h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg min-w-0 flex-1 md:flex-none';

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-8 pt-8 pb-16 fade-up">
      <PageToolbar>
        <div className="toggle w-full md:w-auto [&>button]:flex-1 md:[&>button]:flex-none">
          {[3, 7, 14, 30].map((d) => (
            <button key={d} onClick={() => setPreset(d)} className={presetOn(d) ? 'is-on' : undefined}>{d}d</button>
          ))}
          <button onClick={setAll} className={allOn ? 'is-on' : undefined}>All</button>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <input type="date" value={start} min={range?.earliest} max={range?.latest_visitor}
            onChange={(e) => setStart(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} />
          <span className="text-faint shrink-0">→</span>
          <input type="date" value={end} min={range?.earliest} max={range?.latest_visitor}
            onChange={(e) => setEnd(e.target.value)} className={dateInput} style={{ boxShadow: 'var(--ring)' }} />
        </div>
        {range?.earliest && (
          <span className="ml-auto hidden md:block text-[13px] text-faint">
            Data through {fmtDay(range.latest_visitor)} · Search finalized through {fmtDay(range.freshest)}
          </span>
        )}
      </PageToolbar>

      {error && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">
          Unable to load some real data right now — numbers below may be incomplete. Try refreshing.
        </div>
      )}

      <PageIntro title={introTitle} subtitle={introSubtitle} />

      <KpiStrip items={kpis} loading={loading} />

      <div className="mt-10">
        <PerformanceTrendCard series={series} loading={loading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] mt-10">
        <TopPagesCard pages={rangePages} loading={loading} />
        <AiInsightsPanel channels={channels} queries={rangeQueries} pages={rangePages} loading={loading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] mt-10">
        <TopQueriesCard queries={rangeQueries} loading={loading} />
        <TrafficDistributionCard channels={channels} loading={loading} />
      </div>
    </div>
  );
}
