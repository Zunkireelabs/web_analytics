import { useEffect, useMemo, useState } from 'react';
import { api, daysAgo } from '../api.js';
import TrafficDistributionCard from '../components/TrafficDistributionCard.jsx';
import PerformanceCard from '../components/overview/PerformanceCard.jsx';
import QuickInsights from '../components/overview/QuickInsights.jsx';
import QueriesPagesTable from '../components/overview/QueriesPagesTable.jsx';
import TopPagesCard from '../components/overview/TopPagesCard.jsx';
import { WhereVisitorsStopCard, WhatVisitorsDidCard, ConnectPosthogStrip } from '../components/overview/BehaviorCards.jsx';
import DateRangeBar from '../components/overview/DateRangeBar.jsx';
import { Tray } from '../components/layout/Tray.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import OnboardingSummaryCard from '../components/access/OnboardingSummaryCard.jsx';
import LockedCard from '../components/access/LockedCard.jsx';
import { useAccess } from '../lib/access.jsx';
import { fmtDay, fmtRange } from '../lib/format.js';
import {
  shiftYmd, compareRange, pctDelta, compact, seriesTotals, buildInsights, buildVisitorInsights, behaviorTotals, denseSeries, daysBetween,
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
  // The tab above the chart (search | visitors | behavior). It also decides what shows BELOW the chart, so each tab
  // reads as one story: Search = queries and pages, Visitors = channels and top pages, Behavior = where visitors go.
  const [group, setGroup] = useState('search');
  const [ph, setPh] = useState(null); // PostHog: { summary, series, behaviour, connected, canConnect } for the range
  const [phCompare, setPhCompare] = useState(null); // the same, for the comparison range
  const [gaPages, setGaPages] = useState(null); // { pages, previous }
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
      // PostHog and the Google Analytics page list are extras: a failure or "not connected" leaves them empty and must
      // never break the numbers the page already showed.
      api.product(start, end).catch(() => null),
      cmp ? api.product(cmp.start, cmp.end).catch(() => null) : Promise.resolve(null),
      api.ga4Pages(start, end, cmp?.start, cmp?.end).catch(() => null),
    ])
      .then(([s, cs, c, q, p, product, productCmp, pages]) => {
        if (cancelled) return;
        setSeries(s);
        setCompareSeries(cs);
        setChannels(c);
        setRangeQueries(q);
        setRangePages(p);
        setPh(product);
        setPhCompare(productCmp);
        setGaPages(pages);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, start, end, cmp, rangeReady]);

  const anchor = range?.latest_visitor || range?.freshest || daysAgo(1);

  const cur = useMemo(() => seriesTotals(series), [series]);
  const prev = useMemo(() => (compareSeries ? seriesTotals(compareSeries) : null), [compareSeries]);
  const topChannel = [...channels].sort((a, b) => Number(b.sessions) - Number(a.sessions))[0];
  // Search insights come from queries and pages only; the channel mix is a Visitors note now, so each tab's notes are
  // about that tab's numbers.
  const insights = useMemo(
    () => buildInsights({ channels: [], queries: rangeQueries, pages: rangePages, totalImpressions: cur.impressions }),
    [rangeQueries, rangePages, cur.impressions],
  );
  const visitorInsights = useMemo(() => buildVisitorInsights({ channels }), [channels]);
  const phTotals = useMemo(() => behaviorTotals(ph?.series || []), [ph]);
  const phPrevTotals = useMemo(() => (phCompare?.series?.length ? behaviorTotals(phCompare.series) : null), [phCompare]);
  // PostHog returns only the days it has data for. Spread both periods over every day so the comparison line pairs by date.
  const phDays = daysBetween(start, end) + 1;
  const phSeries = useMemo(() => (ph?.series?.length ? denseSeries(start, phDays, ph.series) : []), [ph, start, phDays]);
  const phCmpSeries = useMemo(() => (cmp ? denseSeries(cmp.start, phDays, phCompare?.series || []) : null), [cmp, phCompare, phDays]);
  const behaviorReady = Boolean(ph?.series?.some((r) => r.pageviews != null || r.sessions != null || r.events != null));

  const impressionsDelta = prev ? pctDelta(cur.impressions, prev.impressions) : null;
  const sessionsDelta = prev ? pctDelta(cur.sessions, prev.sessions) : null;
  const pvDelta = phPrevTotals ? pctDelta(phTotals.pageviews, phPrevTotals.pageviews) : null;
  const upDown = (d) => (Math.abs(d) < 1 ? 'steady' : `${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d))}%`);
  const introTitle = loading ? 'Overview'
    : group === 'visitors' ? (sessionsDelta == null ? 'Visitors in this period' : `Visits are ${upDown(sessionsDelta)} in this period`)
    : group === 'behavior' ? (behaviorReady ? `Visitors viewed ${compact(phTotals.pageviews || 0)} pages in this period` : 'What visitors do on your site')
    : impressionsDelta == null ? 'Search performance for this period'
    : Math.abs(impressionsDelta) < 1 ? 'Impressions are steady in this period'
    : `Impressions are ${impressionsDelta > 0 ? 'up' : 'down'} ${Math.round(Math.abs(impressionsDelta))}% in this period`;
  const topStop = ph?.behaviour?.stops?.[0];
  const introSubtitle = loading ? null
    : group === 'visitors' ? `${compact(cur.sessions)} visits and ${compact(cur.users)} people from ${fmtRange(start, end)}.${topChannel ? ` Most visits came from ${topChannel.channel}.` : ''}`
    : group === 'behavior' ? (behaviorReady
      ? `${pvDelta == null ? '' : `${Math.abs(pvDelta) < 1 ? 'Steady' : pvDelta > 0 ? 'Up' : 'Down'}${Math.abs(pvDelta) < 1 ? '' : ` ${Math.round(Math.abs(pvDelta))}%`} on the previous period. `}${topStop && ph.behaviour.visits ? `Most visits ended on ${topStop.label}, ${topStop.share}% of all visits.` : ''}`.trim()
      : 'Optional. Connect PostHog to see where visitors stop and what they click.')
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

      {!waiting && <ConnectPosthogStrip siteId={siteId} />}

      <PageIntro title={waiting ? 'Overview' : introTitle} subtitle={waiting ? 'Where your site starts, and what your agent works on next' : introSubtitle} />

      <OnboardingSummaryCard />

      {!waiting && (
        <>
          <Tray className="mt-3">
            <PerformanceCard group={group} onGroup={setGroup} series={series} compareSeries={compareSeries} compareLabel={compareLabel} start={start} end={end} channels={channels} loading={loading}
              siteId={siteId}
              behavior={{ series: phSeries, compareSeries: phCmpSeries, connected: Boolean(ph?.connected), status: ph?.status || null, canConnect: Boolean(ph?.canConnect) }} />
          </Tray>

          {group === 'search' && (
            <>
              <Tray className="mt-3">
                <QuickInsights insights={insights} loading={loading} />
              </Tray>
              <Tray className="mt-3">
                <QueriesPagesTable queries={rangeQueries} pages={rangePages} limit={TABLE_LIMIT} loading={loading} />
              </Tray>
            </>
          )}

          {group === 'visitors' && (
            <>
              <Tray className="mt-3 lg:grid-cols-[1fr_2.1fr]">
                <TrafficDistributionCard channels={channels} loading={loading} />
                <QuickInsights insights={visitorInsights} loading={loading} />
              </Tray>
              {gaPages?.pages?.length > 0 && (
                <Tray className="mt-3">
                  <TopPagesCard pages={gaPages.pages} rangeLabel={fmtRange(start, end)} compareLabel={compareLabel}
                    current={gaPages.current} previous={gaPages.previous} dataQuality={gaPages.dataQuality} />
                </Tray>
              )}
            </>
          )}

          {group === 'behavior' && behaviorReady && (
            <>
              <Tray className="mt-3">
                <WhereVisitorsStopCard behaviour={ph.behaviour} rangeLabel={fmtRange(start, end)} />
              </Tray>
              {ph.summary?.topActions?.length > 0 && (
                <Tray className="mt-3">
                  <WhatVisitorsDidCard actions={ph.summary.topActions} visits={ph.behaviour?.visits} rangeLabel={fmtRange(start, end)} />
                </Tray>
              )}
            </>
          )}
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
