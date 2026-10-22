import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Link } from 'react-router-dom';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Section from '../components/layout/Section.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import Button from '../components/Button.jsx';
import { fmtDay, fmtRange } from '../lib/format.js';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import MoversList from '../components/MoversList.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import AgentFindingsHub from '../components/AgentFindingsHub.jsx';
import RecommendationCard from '../components/RecommendationCard.jsx';
import ReportHistoryRail from '../components/ReportHistoryRail.jsx';

const fmtInt = (v) => Number(v).toLocaleString();
const fmtFloat = (v) => Number(v).toFixed(1);

const PERIODS = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// /report-summary's real comparison window per tab (server/routes/metrics.js:
// daily compares vs yesterday, weekly/monthly vs the immediately preceding
// week/month) — describes that real window instead of a hardcoded "last week,"
// which was wrong for the daily and monthly tabs.
const MOVER_COMPARISON_LABEL = { daily: 'yesterday', weekly: 'the prior week', monthly: 'the prior month' };

function periodLabel(data) {
  if (!data) return '';
  if (data.period === 'daily') return data.date ? `${fmtDay(data.date)} ${data.date.slice(0, 4)}` : '';
  if (data.period === 'weekly') return data.start && data.end ? fmtRange(data.start, data.end) : '';
  if (data.period === 'monthly' && data.ym) {
    const [y, m] = data.ym.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  return '';
}

export default function Reports({ siteId }) {
  const [period, setPeriod] = useState('daily');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Page-level, not period-scoped — agent findings/recommendations aren't
  // tied to a Daily/Weekly/Monthly tab, so fetched once per site, not per tab.
  const [insights, setInsights] = useState(null);

  useEffect(() => {
    if (!siteId) return;
    // Guards against an out-of-order response overwriting the currently
    // selected tab's data — without this, switching Daily -> Weekly ->
    // Monthly quickly could let an earlier tab's slower request resolve
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
  const introTitle = loading || !data ? 'Reports'
    : data.period === 'daily' ? `Daily report · ${fmtDay(data.date)}`
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
    <div className="max-w-[1360px] mx-auto px-4 md:px-8 pt-8 pb-16 fade-up">
      <PageToolbar>
        <div className="no-print max-w-full overflow-x-auto no-scrollbar">
          <SegmentedTabs options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} value={period} onChange={setPeriod} />
        </div>
        {!loading && data && label && <span className="hidden md:inline text-[13px] text-faint ml-2">Report for {label}</span>}
        <div className="ml-auto flex gap-2 no-print">
          {!loading && data?.docUrl && (
            <a href={data.docUrl} target="_blank" rel="noreferrer" className="btn btn--light">View Google Doc ↗</a>
          )}
          <Button variant="primary" onClick={() => window.print()}>Export PDF</Button>
        </div>
      </PageToolbar>

      <PageIntro title={introTitle} subtitle="Your AI executive briefing, with how search moved over the period." />

      {error ? (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">Unable to load this report right now.</div>
      ) : (
        <>
          {/* source/generatedAt are deliberately omitted — /report-summary
              never actually returns either (only Command Center's route
              does), so passing them here would always be null/false and
              imply a freshness timestamp this page doesn't really have. */}
          <ExecutiveSummaryPanel text={data?.narrative} />

          <div className="mt-6">
            <KpiStrip items={kpis} loading={loading} cols={5} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] mt-10 items-start">
            <div className="min-w-0">
              <PerformanceTrendCard series={data?.series} loading={loading} />
            </div>
            <Section className="min-w-0" title="Report history" subtitle="Clicks per period, newest first">
              <ReportHistoryRail history={data?.history} />
            </Section>
          </div>

          {!loading && data?.movers && (data.movers.gainers.length > 0 || data.movers.droppers.length > 0) && (
            <div className="mt-10">
              <MoversList gainers={data.movers.gainers} droppers={data.movers.droppers} comparisonLabel={MOVER_COMPARISON_LABEL[period]} />
            </div>
          )}

          {findings.length > 0 && (
            <Section className="mt-10" title="Agent findings" subtitle={`${findings.length} agents reported`}>
              <AgentFindingsHub findings={findings} />
            </Section>
          )}

          {recommendations.length > 0 && (
            <div id="recommendations-section" className="scroll-mt-6 mt-10">
              <Section title="Priority recommendations" subtitle="What to do next, by expected impact"
                action={<Link to="/action-center" className="btn btn--light no-print">Open Action Center</Link>}>
                <div className="card overflow-hidden">
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
