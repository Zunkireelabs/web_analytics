import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import GrowthTrendCard from '../components/GrowthTrendCard.jsx';
import GrowthProjectionCard from '../components/GrowthProjectionCard.jsx';
import SiteAuditSummaryCard from '../components/SiteAuditSummaryCard.jsx';
import GrowthPlanNarrativeCard from '../components/GrowthPlanNarrativeCard.jsx';

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

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8 fade-up">
      <PageHeader title="Milestones" icon="🌱"
        subtitle="Real progress since your onboarding baseline — every number here traces to a real, already-verified source." />

      {isInternal && clients.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor="milestones-client-picker" className="text-xs font-bold text-slate-500 uppercase tracking-widest">Client</label>
          <select id="milestones-client-picker" value={selectedSiteId ?? ''}
            onChange={(e) => setSelectedSiteId(e.target.value ? Number(e.target.value) : null)}
            className="text-xs font-bold bg-white border border-slate-200/80 rounded-xl px-2.5 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 shadow-sm transition">
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {error ? (
        <div className="card p-6 text-sm text-slate-500 text-center">Unable to load your growth report right now.</div>
      ) : data === null ? (
        <div className="card p-8 text-center text-sm text-slate-400">Loading…</div>
      ) : !data.available ? (
        <div className="card p-10 text-center space-y-2">
          <p className="text-2xl">🌱</p>
          <p className="text-sm font-semibold text-slate-700">{data.message}</p>
        </div>
      ) : (
        <>
          {/* Executive KPI Ribbon */}
          <div className="card-dark p-4 px-6 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-indigo-600/90 text-white grid place-items-center shadow-md shadow-indigo-500/25 shrink-0">
                  <Activity size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-black tracking-tight">Onboarding Baseline Established</h3>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-500/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Active Monitoring
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 font-medium mt-0.5">
                    Baseline: <strong className="text-white">{data.onboardedAt}</strong> ➔ Today
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {siteHealth != null && (
                  <div className="px-3.5 py-1.5 rounded-xl bg-white/10 border border-white/10 text-center">
                    <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">Health Baseline</span>
                    <span className={`text-sm font-black ${siteHealth >= 80 ? 'text-emerald-400' : siteHealth >= 50 ? 'text-amber-400' : 'text-rose-400'}`}>
                      {siteHealth}/100
                    </span>
                  </div>
                )}
                <div className="px-3.5 py-1.5 rounded-xl bg-white/10 border border-white/10 text-center">
                  <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">Total Findings</span>
                  <span className="text-sm font-black text-white">{totalFindings}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 1: Where You Stand Today */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-600" />
              <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Where You Stand Today</h2>
            </div>
            <SiteAuditSummaryCard siteAudit={data.siteAudit} loading={false} />
          </div>

          {/* Section 2: Growth Plan & Performance — combined narrative,
              AI projections, and historical trends in one compact section
              (previously two separate stacked sections). */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#6C63FF]" />
              <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Your Growth Plan & Performance Trends</h2>
            </div>
            <div className="space-y-4">
              <GrowthPlanNarrativeCard growthPlan={data.growthPlan} loading={false} />

              {/* Compact AI projections — 6 metrics in one tight row instead
                  of two full-width 3-up grids. */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <GrowthProjectionCard title="Health Score" icon="💚" color="#10b981" compact
                  projection={data.healthScore.projection} />
                <GrowthProjectionCard title="Weekly Clicks" icon="📈" color="#6C63FF" unit="/week" compact
                  projection={data.performance.clicksProjection} />
                <GrowthProjectionCard title="Weekly Impressions" icon="👁️" color="#f59e0b" unit="/week" compact
                  projection={data.performance.impressionsProjection} />
                <GrowthProjectionCard title="Competitor Readiness" icon="🏁" color="#f59e0b" compact
                  projection={data.competitorTrend?.projection} />
                <GrowthProjectionCard title="Authority Score" icon="🔗" color="#8b5cf6" compact
                  projection={data.authorityTrend?.projection} />
                <GrowthProjectionCard title="AI Recommendation Rate" icon="✦" color="#6C63FF" unit="%" compact
                  projection={data.aiRecommendationTrend?.projection} />
              </div>

              {/* Historical trend charts, side-by-side where reasonable. */}
              <div className="grid lg:grid-cols-2 gap-4">
                <PerformanceTrendCard series={data.performance.series} targets={data.performance.targets} loading={false} onTargetSaved={load} showClicksProjectionNote />
                <GrowthTrendCard id="health" title="Website Health Score" icon="💚" color="#10b981"
                  data={data.healthScore} emptyMessage="Not enough health-score history yet." onTargetSaved={load} />
              </div>

              <div className="grid lg:grid-cols-3 gap-4">
                <GrowthTrendCard id="competitor" title="Competitor Readiness"
                  subtitle={data.competitorTrend?.domain ? `vs. ${data.competitorTrend.domain}` : undefined}
                  icon="🏁" color="#f59e0b" data={data.competitorTrend}
                  emptyMessage="No tracked competitor has enough history yet." onTargetSaved={load} />
                <GrowthTrendCard id="authority" title="Authority Score" icon="🔗" color="#8b5cf6"
                  subtitle={data.authorityTrend?.dataSource === 'commoncrawl' ? 'Coarser estimate (free Common Crawl data — referring domains only)' : undefined}
                  data={data.authorityTrend} emptyMessage="Needs real DataForSEO backlink data (or free Common Crawl data) — neither connected yet." onTargetSaved={load} />
                <GrowthTrendCard id="ai-rec" title="AI Recommendation Rate" unit="%" icon="✦" color="#6C63FF"
                  data={data.aiRecommendationTrend} emptyMessage="No AI recommendation checks have run yet." onTargetSaved={load}
                  action={data.aiRecommendationTrend?.configured && !data.aiRecommendationTrend?.available
                    ? { label: 'Run First AI Recommendation Check', run: () => api.runAiRecommendation() }
                    : undefined} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


