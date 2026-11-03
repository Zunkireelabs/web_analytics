import { useEffect, useMemo, useState } from 'react';
import { api, daysAgo } from '../api.js';
import TrafficDistributionCard from '../components/TrafficDistributionCard.jsx';
import PerformanceCard from '../components/overview/PerformanceCard.jsx';
import QuickInsights from '../components/overview/QuickInsights.jsx';
import QueriesPagesTable from '../components/overview/QueriesPagesTable.jsx';
import DateRangeBar from '../components/overview/DateRangeBar.jsx';
import { Tray } from '../components/layout/Tray.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import OnboardingSummaryCard from '../components/access/OnboardingSummaryCard.jsx';
import LockedCard from '../components/access/LockedCard.jsx';
import { useAccess } from '../lib/access.jsx';
import { fmtDay, fmtRange } from '../lib/format.js';
import {
  shiftYmd, compareRange, pctDelta, compact, seriesTotals, buildInsights,
} from '../lib/overview-view.js';

const TABLE_LIMIT = 50; // rows asked of the server for the Queries and Pages table, which it pages through itself

const COMPARE_LABEL = { prev: 'vs previous period', year: 'vs last year', custom: 'vs the other period' };

export default function Overview({ siteId }) {
  // A project still waiting for approval has no data to show yet: its setup and what is locked. A finished demo keeps the
  // data it had (and the same lock cards beside it).
  const access = useAccess();
  const locked = Boolean(access?.locked);
  const waiting = locked && access.state !== 'ended';
  const [range, setRange] = useState(null);
  const [start, setStart] = useState(daysAgo(31));
  const [end, setEnd] = useState(daysAgo(3));
  const [compareMode, setCompareMode] = useState('prev');
  const [compareCustom, setCompareCustom] = useState(null);
  const [series, setSeries] = useState([]);
  const [compareSeries, setCompareSeries] = useState(null);
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
        setStart(shiftYmd(latest, 28));
      }
    }).catch(() => setError(true)).finally(() => setRangeReady(true));
  }, [siteId]);

  const cmp = useMemo(() => compareRange(compareMode, start, end, compareCustom), [compareMode, start, end, compareCustom]);

  useEffect(() => {
    // Wait for the range-fetch effect above to resolve the real start/end
    // before fetching data — otherwise this fires once with the placeholder
    // default dates and again with the corrected ones, wasting a full
    // round-trip on every load.
    if (!siteId || !rangeReady) return undefined;
    setLoading(true);
    let cancelled = false;
    Promise.all([
      api.series(siteId, start, end),
      cmp ? api.series(siteId, cmp.start, cmp.end) : Promise.resolve(null),
      api.channels(siteId, start, end),
      api.breakdownRange(siteId, start, end, 'query', TABLE_LIMIT),
      api.breakdownRange(siteId, start, end, 'page', TABLE_LIMIT),
    ])
      .then(([s, cs, c, q, p]) => {
        if (cancelled) return;
        setSeries(s);
        setCompareSeries(cs);
        setChannels(c);
        setRangeQueries(q);
        setRangePages(p);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, start, end, cmp, rangeReady]);

  const anchor = range?.latest_visitor || range?.freshest || daysAgo(1);

  const cur = useMemo(() => seriesTotals(series), [series]);
  const prev = useMemo(() => (compareSeries ? seriesTotals(compareSeries) : null), [compareSeries]);
  const topChannel = [...channels].sort((a, b) => Number(b.sessions) - Number(a.sessions))[0];
  const insights = useMemo(
    () => buildInsights({ channels, queries: rangeQueries, pages: rangePages, totalImpressions: cur.impressions }),
    [channels, rangeQueries, rangePages, cur.impressions],
  );

  const impressionsDelta = prev ? pctDelta(cur.impressions, prev.impressions) : null;
  const introTitle = loading ? 'Overview'
    : impressionsDelta == null ? 'Search performance for this period'
    : Math.abs(impressionsDelta) < 1 ? 'Impressions are steady in this period'
    : `Impressions are ${impressionsDelta > 0 ? 'up' : 'down'} ${Math.round(Math.abs(impressionsDelta))}% in this period`;
  const introSubtitle = loading ? null
    : `${compact(cur.impressions)} impressions and ${compact(cur.clicks)} clicks from ${fmtRange(start, end)}.${topChannel ? ` Most visits came from ${topChannel.channel}.` : ''}`;

  const compareLabel = cmp ? (compareMode === 'custom' ? `vs ${fmtRange(cmp.start, cmp.end)}` : COMPARE_LABEL[compareMode]) : null;
  const onRange = (r) => { setStart(r.start); setEnd(r.end); };
  const onCompare = (mode, custom) => { setCompareMode(mode); setCompareCustom(custom); };

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      {error && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">
          Unable to load some real data right now — numbers below may be incomplete. Try refreshing.
        </div>
      )}

      {!waiting && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <DateRangeBar start={start} end={end} anchor={anchor} earliest={range?.earliest} compareMode={compareMode} compareCustom={compareCustom}
            onRange={onRange} onCompare={onCompare} />
          {range?.earliest && (
            <span className="md:ml-auto text-[13px] text-faint">
              Data through {fmtDay(range.latest_visitor)} · Search finalized through {fmtDay(range.freshest)}
            </span>
          )}
        </div>
      )}

      <PageIntro title={waiting ? 'Overview' : introTitle} subtitle={waiting ? 'Where your site starts, and what your agent works on next' : introSubtitle} />

      <OnboardingSummaryCard />

      {!waiting && (
        <>
          <Tray className="mt-3">
            <PerformanceCard series={series} compareSeries={compareSeries} compareLabel={compareLabel} start={start} end={end} channels={channels} loading={loading} />
          </Tray>

          <Tray className="mt-3 lg:grid-cols-[1fr_2.1fr]">
            <TrafficDistributionCard channels={channels} loading={loading} />
            <QuickInsights insights={insights} loading={loading} />
          </Tray>

          <Tray className="mt-3">
            <QueriesPagesTable queries={rangeQueries} pages={rangePages} limit={TABLE_LIMIT} loading={loading} />
          </Tray>
        </>
      )}

      {locked && (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <LockedCard title="AI visibility" text="See whether ChatGPT and Perplexity mention you." cta />
          <LockedCard title="Recommended actions" text="Exactly what to fix first, with a ready-to-ship fix." />
          <LockedCard title="Competitor performance" text="Who AI engines recommend instead of you." />
        </div>
      )}
    </div>
  );
}
