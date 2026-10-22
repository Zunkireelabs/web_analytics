import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Section from '../components/layout/Section.jsx';
import Badge from '../components/Badge.jsx';
import { fmtDay } from '../lib/format.js';
import { STATUS } from '../lib/palette.js';
import { Tray } from '../components/layout/Tray.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import GrowthTrendCard from '../components/GrowthTrendCard.jsx';
import GrowthProjectionCard from '../components/GrowthProjectionCard.jsx';
import SiteAuditSummaryCard from '../components/SiteAuditSummaryCard.jsx';
import GrowthPlanNarrativeCard from '../components/GrowthPlanNarrativeCard.jsx';
import BaselineReportCard from '../components/BaselineReportCard.jsx';

// Chevron for the client picker (same as .fld select in index.css).
const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%238a8a8a' stroke-width='1.6'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")";

// Client-facing "how much have we actually grown you" view — real data
// only, strictly anchored to the site's real onboarding baseline (see
// server/agents/lib/growth-report.js). No baseline yet -> an honest empty
// state, never a chart anchored to a fabricated start date.
//
// isInternal (Platform Admin Milestones picker) — an internal admin can pick
// a different client from a dropdown above the page; picking one re-fetches
// via api.growthReport(siteId), which hits the staff-only
// /internal/growth-report/:siteId route (server/routes/growth-report.js)
// instead of the plain session-scoped one. Regular client users never get
// the prop (or get it false), so they never see the picker and every fetch
// stays exactly the plain api.growthReport() call, unchanged from before.
export default function GrowthReport({ isInternal = false }) {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(false);
  const [clients, setClients] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState(null); // null = admin's own site (default)
  const [baselineReport, setBaselineReport] = useState(null); // null = loading

  const loadBaselineReport = () => {
    const requestedSiteId = selectedSiteId;
    return api.baselineReport(requestedSiteId || undefined)
      .then((result) => { if (requestedSiteId === selectedSiteId) setBaselineReport(result); })
      .catch(() => { if (requestedSiteId === selectedSiteId) setBaselineReport({ available: false, message: 'Unable to load your baseline report right now.' }); });
  };
  useEffect(() => { setBaselineReport(null); loadBaselineReport(); }, [selectedSiteId]);

  const load = () => {
    const requestedSiteId = selectedSiteId;
    return api.growthReport(requestedSiteId || undefined)
      .then((result) => {
        // Ignore a stale response if the admin switched clients again while
        // this request was still in flight.
        if (requestedSiteId !== selectedSiteId) return;
        setData(result);
      })
      .catch(() => { if (requestedSiteId === selectedSiteId) setError(true); });
  };
  useEffect(() => { setData(null); setError(false); load(); }, [selectedSiteId]);

  useEffect(() => {
    if (!isInternal) return;
    api.clients.list()
      // Milestones is a real-progress-since-onboarding view — only clients
      // with an actual onboarding baseline belong here. This also happens to
      // filter out soft-deleted sites, never-onboarded test sites, and
      // leftover design-agent-worker.test.js fixture rows without needing a
      // name-based blocklist.
      .then((all) => {
        const real = all.filter((c) => c.status === 'active' && c.baselined);
        setClients(real);
        // No "My site" option here (this is staff viewing clients, not a
        // client viewing their own site) — land on the first real client
        // instead of an unselected/blank picker.
        setSelectedSiteId((prev) => prev ?? real[0]?.id ?? null);
      })
      .catch(() => {});
  }, [isInternal]);

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
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        {isInternal && clients.length > 0 && (
          <>
            <label htmlFor="milestones-client-picker" className="text-[13px] text-faint">Client</label>
            <select id="milestones-client-picker" value={selectedSiteId ?? ''}
              onChange={(e) => setSelectedSiteId(e.target.value ? Number(e.target.value) : null)}
              className="h-8 pl-2.5 pr-8 rounded-control bg-white text-[13px] font-medium text-fg appearance-none"
              style={{
                boxShadow: 'var(--ring)',
                backgroundImage: CHEVRON,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 10px center',
              }}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </>
        )}
        {data?.available && (
          <span className="ml-auto hidden md:inline-flex"><Badge tone="green" dot>Active monitoring</Badge></span>
        )}
      </PageToolbar>

      <PageIntro
        title={data?.available ? `Progress since the ${fmtDay(data.onboardedAt)} ${onboardedYear} baseline` : 'Milestones'}
        subtitle="Every number here traces to a real, already-verified source." />

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
            <BaselineReportCard report={baselineReport} siteId={isInternal ? selectedSiteId : undefined}
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
