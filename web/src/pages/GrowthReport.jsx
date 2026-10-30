import { useEffect, useState } from 'react';
import { api } from '../api.js';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Section from '../components/layout/Section.jsx';
import { fmtDay } from '../lib/format.js';
import { STATUS } from '../lib/palette.js';
import { Tray } from '../components/layout/Tray.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import GrowthTrendCard from '../components/GrowthTrendCard.jsx';
import GrowthProjectionCard from '../components/GrowthProjectionCard.jsx';
import SiteAuditSummaryCard from '../components/SiteAuditSummaryCard.jsx';
import GrowthPlanNarrativeCard from '../components/GrowthPlanNarrativeCard.jsx';
import BaselineReportCard from '../components/BaselineReportCard.jsx';

// The baseline half of the Reports page (its "Baseline" tab; this used to be the Milestones page):
// "how much have we actually grown you" — real data only, strictly anchored to the site's real onboarding
// baseline (see server/agents/lib/growth-report.js). It opens with where the site stood when it first
// landed (the baseline report, with the issues and security findings from the first full audit), then how
// it has moved since. No baseline yet -> an honest empty state, never a chart anchored to a made-up date.
//
// It always shows the session's own project. A platform admin looks at a client's by switching into that
// project (the workspace switcher), not through a picker here. `siteId` is only used so staff can generate
// a missing baseline report for the project they are in.
export function GrowthReportBody({ isInternal = false, siteId }) {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(false);
  const [baselineReport, setBaselineReport] = useState(null); // null = loading

  const loadBaselineReport = () => api.baselineReport()
    .then(setBaselineReport)
    .catch(() => setBaselineReport({ available: false, message: 'Unable to load your baseline report right now.' }));
  useEffect(() => { loadBaselineReport(); }, []);

  const load = () => api.growthReport()
    .then(setData)
    .catch(() => setError(true));
  useEffect(() => { load(); }, []);

  // A Full Site Audit can take from seconds to well over an hour — poll
  // while it's still running so "Where You Stand Today" reflects real
  // checkpointed progress rather than only the outcome once it finishes.
  useEffect(() => {
    if (data?.siteAudit?.run?.status !== 'running') return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [data?.siteAudit?.run?.status]);

  const siteHealth = data?.siteAudit?.run?.healthScore;
  const categories = Object.entries(data?.siteAudit?.findingsByCategory || {});
  const totalFindings = categories.reduce((sum, [, list]) => sum + list.length, 0);

  const onboardedYear = data?.onboardedAt ? String(data.onboardedAt).slice(0, 4) : '';
  const healthTone = siteHealth >= 80 ? STATUS.good.text : siteHealth >= 50 ? STATUS.warning.text : STATUS.critical.text;
  const healthSub = siteHealth >= 80 ? 'optimal site health' : siteHealth >= 50 ? 'moderate site health' : 'critical fixes required';
  const kpis = data?.available ? [
    { label: 'Baseline', value: `${fmtDay(data.onboardedAt)} ${onboardedYear}`, sub: 'onboarding date' },
    ...(siteHealth != null ? [{
      label: 'Health at baseline',
      value: <><span style={{ color: healthTone }}>{siteHealth}</span><span className="text-[13px] text-faint font-normal">/100</span></>,
      sub: healthSub,
    }] : []),
    { label: 'Findings', value: totalFindings, sub: 'from the latest site audit' },
  ] : [];

  return (
    <div>
      {error ? (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3">Unable to load your growth report right now.</div>
      ) : data === null ? (
        <KpiStrip cols={3} loading items={[{}, {}, {}]} />
      ) : !data.available ? (
        <div className="tray"><div className="tray-card px-4 py-10 text-center text-sm text-text">{data.message}</div></div>
      ) : (
        <>
          <KpiStrip cols={3} items={kpis} />

          <div className="mt-3">
            <BaselineReportCard report={baselineReport} siteId={isInternal ? siteId : undefined}
              isInternal={isInternal} onGenerated={loadBaselineReport} />
          </div>

          <Section tray className="mt-3" title="Where you stand today" subtitle="The latest full crawl of your site">
            <SiteAuditSummaryCard siteAudit={data.siteAudit} loading={false} />
          </Section>

          {/* Growth plan & performance — consecutive trays: the roadmap narrative,
              the AI projections strip, then the real history behind them. */}
          {data.growthPlan?.available && (
            <Tray className="mt-3">
              <GrowthPlanNarrativeCard growthPlan={data.growthPlan} loading={false} />
            </Tray>
          )}

          {/* Compact AI projections — 6 metrics in one hairline strip (gap-px on
              the inner grid draws the lines; the bg-border sits on the grid, not
              on the card). */}
          <Section tray className="mt-3" title="Growth plan and trends" subtitle="Three-month projections, then the real history behind them">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-border border-t border-border">
              <GrowthProjectionCard title="Health Score" compact
                projection={data.healthScore.projection} />
              <GrowthProjectionCard title="Weekly Clicks" unit="/week" compact
                projection={data.performance.clicksProjection} />
              <GrowthProjectionCard title="Weekly Impressions" unit="/week" compact
                projection={data.performance.impressionsProjection} />
              <GrowthProjectionCard title="Competitor Readiness" compact
                projection={data.competitorTrend?.projection} />
              <GrowthProjectionCard title="Authority Score" compact
                projection={data.authorityTrend?.projection} />
              <GrowthProjectionCard title="AI Recommendation Rate" unit="%" compact
                projection={data.aiRecommendationTrend?.projection} />
            </div>
          </Section>

          {/* Historical trend charts, side-by-side where reasonable. */}
          <Tray className="mt-3 lg:grid-cols-2">
            <PerformanceTrendCard series={data.performance.series} targets={data.performance.targets} loading={false} onTargetSaved={load} showClicksProjectionNote />
            <GrowthTrendCard id="health" title="Website Health Score"
              data={data.healthScore} emptyMessage="Not enough health-score history yet." onTargetSaved={load} />
          </Tray>

          <Tray className="mt-3 lg:grid-cols-3">
            <GrowthTrendCard id="competitor" title="Competitor Readiness"
              subtitle={data.competitorTrend?.domain ? `vs. ${data.competitorTrend.domain}` : undefined}
              data={data.competitorTrend}
              emptyMessage="No tracked competitor has enough history yet." onTargetSaved={load} />
            <GrowthTrendCard id="authority" title="Authority Score"
              subtitle={data.authorityTrend?.dataSource === 'commoncrawl' ? 'Coarser estimate (free Common Crawl data — referring domains only)' : undefined}
              data={data.authorityTrend} emptyMessage="Needs real DataForSEO backlink data (or free Common Crawl data) — neither connected yet." onTargetSaved={load} />
            <GrowthTrendCard id="ai-rec" title="AI Recommendation Rate" unit="%"
              data={data.aiRecommendationTrend} emptyMessage="No AI recommendation checks have run yet." onTargetSaved={load}
              action={data.aiRecommendationTrend?.configured && !data.aiRecommendationTrend?.available
                ? { label: 'Run First AI Recommendation Check', run: () => api.runAiRecommendation() }
                : undefined} />
          </Tray>
        </>
      )}
    </div>
  );
}

export default GrowthReportBody;
