import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Link } from 'react-router-dom';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import { Tray, TrayCard } from '../components/layout/Tray.jsx';
import Section from '../components/layout/Section.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import { fmtRange } from '../lib/format.js';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import MoversList from '../components/MoversList.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import AgentFindingsHub from '../components/AgentFindingsHub.jsx';
import RecommendationCard from '../components/RecommendationCard.jsx';
import ReportHistoryRail from '../components/ReportHistoryRail.jsx';
import { GrowthReportBody } from './GrowthReport.jsx';
import ReportBand from '../components/report/ReportBand.jsx';
import BrandTiles from '../components/report/BrandTiles.jsx';
import ReportBody from '../components/report/ReportBody.jsx';

const fmtInt = (v) => Number(v).toLocaleString();
const fmtFloat = (v) => Number(v).toFixed(1);

// The Baseline tab is the report from the day the site first landed: the issues and security findings from
// the first full audit, then how the site has moved since (this used to be the separate Milestones page).
// Weekly and monthly follow it (a yearly report can be added later). There is no daily report: a single day is noise, and the daily
// numbers are still on Overview and Insights.
const TABS = [
  { key: 'baseline', label: 'Baseline' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// /report-summary's real comparison window per tab (server/routes/metrics.js): weekly and monthly compare
// against the immediately preceding week/month.
const MOVER_COMPARISON_LABEL = { weekly: 'the prior week', monthly: 'the prior month' };

function periodLabel(data) {
  if (!data) return '';
  if (data.period === 'weekly') return data.start && data.end ? fmtRange(data.start, data.end) : '';
  if (data.period === 'monthly' && data.ym) {
    const [y, m] = data.ym.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  return '';
}

export default function Reports({ siteId, isInternal = false }) {
  const [period, setPeriod] = useState(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); return TABS.some((x) => x.key === t) ? t : 'baseline'; } catch { return 'baseline'; }
  });
  const changePeriod = (t) => {
    setPeriod(t);
    try { const u = new URL(window.location.href); u.searchParams.set('tab', t); window.history.replaceState(null, '', u); } catch { /* the URL is a convenience */ }
  };
  const isBaseline = period === 'baseline';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Page-level, not period-scoped — agent findings/recommendations aren't
  // tied to a Daily/Weekly/Monthly tab, so fetched once per site, not per tab.
  const [insights, setInsights] = useState(null);
  // The project's own brand (colour, logo): the report is painted in it, so each client's looks like theirs.
  const [brand, setBrand] = useState(null);
  // Whether a baseline report exists: the Baseline tab's own Download PDF depends on that alone, not on the rest of the
  // growth report being ready (the card inside it only shows then).
  const [baselineReady, setBaselineReady] = useState(false);
  useEffect(() => {
    if (!siteId) return;
    (isInternal ? api.baselineReport(siteId) : api.baselineReport()).then((r) => setBaselineReady(!!r?.available)).catch(() => setBaselineReady(false));
  }, [siteId, isInternal]);
  useEffect(() => {
    if (!siteId) return;
    api.reportBrand(siteId).then(setBrand).catch(() => setBrand(null));
  }, [siteId]);

  useEffect(() => {
    if (!siteId || isBaseline) return; // the baseline tab loads its own report
    // Guards against an out-of-order response overwriting the currently
    // selected tab's data — without this, switching Weekly -> Monthly -> Baseline
    // quickly could let an earlier tab's slower request resolve
    // LAST and silently win, showing e.g. the Weekly doc/metrics while the
    // Monthly tab is the one actually selected. Same convention already
    // used by Overview.jsx/Insights.jsx/AiGrowth.jsx.
    let cancelled = false;
    setLoading(true);
    setError(false);
    api.reportSummary(siteId, period)
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, period]);

  useEffect(() => {
    if (!siteId) return;
    api.reportInsights(siteId).then(setInsights).catch(() => setInsights(null));
  }, [siteId]);

  const m = data?.metrics;
  const findings = insights?.agentFindings || [];
  const recommendations = insights?.recommendations || [];

  const label = periodLabel(data);
  const introTitle = isBaseline ? 'Baseline report'
    : loading || !data ? 'Reports'
    : data.period === 'weekly' ? `Weekly report · ${label}`
    : `Monthly report · ${label}`;

  // No previous-period values exist for these tiles, so no deltas — the sub is
  // the period the numbers cover.
  const kpis = [
    { label: 'Clicks', value: m?.clicks == null ? '—' : fmtInt(m.clicks), sub: label },
    { label: 'Impressions', value: m?.impressions == null ? '—' : fmtInt(m.impressions), sub: label },
    { label: 'Avg position', value: m?.position == null ? '—' : fmtFloat(m.position), sub: 'lower is better' },
    { label: 'Users', value: m?.users == null ? '—' : fmtInt(m.users), sub: label },
    { label: 'Sessions', value: m?.sessions == null ? '—' : fmtInt(m.sessions), sub: label },
  ];

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <div className="no-print max-w-full overflow-x-auto no-scrollbar">
          <SegmentedTabs options={TABS.map((p) => ({ value: p.key, label: p.label }))} value={period} onChange={changePeriod} />
        </div>
        {!isBaseline && !loading && data && label && <span className="hidden md:inline text-[13px] text-faint ml-2">Report for {label}</span>}
        {isBaseline && baselineReady && (
          <div className="ml-auto flex gap-2 no-print">
            <a className="btn btn--primary" href={api.baselineReportDownloadUrl(isInternal ? siteId : undefined)}>Download PDF</a>
          </div>
        )}
        {!isBaseline && (
          <div className="ml-auto flex gap-2 no-print">
            {!loading && data?.docUrl && (
              <a href={data.docUrl} target="_blank" rel="noreferrer" className="btn btn--light">View Google Doc ↗</a>
            )}
            <a className="btn btn--primary" href={(period === 'weekly' ? api.weeklyReportDownloadUrl : api.progressReportDownloadUrl)(isInternal ? siteId : undefined)}>Export PDF</a>
          </div>
        )}
      </PageToolbar>

      <PageIntro title={introTitle}
        subtitle={isBaseline
          ? 'Where your site stood when it first landed, the issues and security findings from the first full audit, and how it has moved since.'
          : 'Your AI executive briefing, with how search moved over the period.'} />

      {isBaseline ? (
        <>
          <div className="mb-3"><ReportBand brand={brand} kind="Baseline report" period="Where your site started" /></div>
          <GrowthReportBody isInternal={isInternal} siteId={siteId} />
        </>
      ) : error ? (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">Unable to load this report right now.</div>
      ) : (
        <>
          {/* source/generatedAt are deliberately omitted — /report-summary
              never actually returns either (only Command Center's route
              does), so passing them here would always be null/false and
              imply a freshness timestamp this page doesn't really have. */}
          <div className="mb-3"><ReportBand brand={brand} kind={data?.period === 'weekly' ? 'Weekly report' : data?.period === 'monthly' ? 'Monthly report' : 'Report'} period={label} /></div>
          {data?.body && brand ? (
            <ReportBody body={data.body} brand={brand} narrative={data.narrative} />
          ) : (
            <>
              <Tray><ExecutiveSummaryPanel text={data?.narrative} /></Tray>

              <div className="mt-3">
                {brand ? <BrandTiles items={kpis} brand={brand} loading={loading} /> : <KpiStrip items={kpis} loading={loading} cols={5} />}
              </div>
            </>
          )}

          <Tray className="mt-3 lg:grid-cols-[1.6fr_1fr]">
            <PerformanceTrendCard series={data?.series} loading={loading} />
            <TrayCard title="Report history" subtitle="Clicks per period, newest first">
              <ReportHistoryRail history={data?.history} />
            </TrayCard>
          </Tray>

          {!loading && data?.movers && (data.movers.gainers.length > 0 || data.movers.droppers.length > 0) && (
            <div className="mt-3">
              <MoversList gainers={data.movers.gainers} droppers={data.movers.droppers} comparisonLabel={MOVER_COMPARISON_LABEL[period]} />
            </div>
          )}

          {findings.length > 0 && (
            <Section tray className="mt-3" title="Agent findings" subtitle={`${findings.length} agents reported`}>
              <AgentFindingsHub findings={findings} />
            </Section>
          )}

          {recommendations.length > 0 && (
            <div id="recommendations-section" className="scroll-mt-6 mt-3">
              <Section tray title="Priority recommendations" subtitle="What to do next, by expected impact"
                action={<Link to="/action-center" className="btn btn--light no-print">Open Action Center</Link>}>
                <div className="border-t border-border">
                  {recommendations.map((r) => (
                    <RecommendationCard key={r.id} title={r.title} reason={r.reason}
                      impact={r.impact} effort={r.effort} category={r.category} />
                  ))}
                </div>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
