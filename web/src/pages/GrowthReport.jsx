import { useEffect, useState } from 'react';
import { Users, User, Calendar, ShieldCheck, Activity, Sparkles, TrendingUp } from 'lucide-react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import GrowthTrendCard from '../components/GrowthTrendCard.jsx';
import GrowthProjectionCard from '../components/GrowthProjectionCard.jsx';
import SiteAuditSummaryCard from '../components/SiteAuditSummaryCard.jsx';
import GrowthPlanNarrativeCard from '../components/GrowthPlanNarrativeCard.jsx';

// Staff-only — every onboarded client's AI-projected growth in one place
function AllClientsMilestones() {
  const [clients, setClients] = useState(null); // null = loading
  const [error, setError] = useState(false);

  useEffect(() => {
    api.clients.growthSummary().then(setClients).catch(() => setError(true));
  }, []);

  if (error) return <div className="card p-6 text-sm text-slate-500 text-center">Unable to load client milestones right now.</div>;
  if (clients === null) return <div className="card p-8 text-center text-sm text-slate-400">Loading every client…</div>;
  if (!clients.length) return <div className="card p-8 text-center text-sm text-slate-400">No onboarded clients yet.</div>;

  const totalHighPriority = clients.reduce((acc, c) => acc + (c.healthScoreProjection?.highPriorityCount || 0), 0);
  const totalOpen = clients.reduce((acc, c) => acc + (c.healthScoreProjection?.openCount || 0), 0);

  return (
    <div className="space-y-6 fade-up">
      {/* Executive Portfolio Overview Banner */}
      <div className="card-dark p-5 shadow-md space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600/90 text-white grid place-items-center shadow-md shadow-indigo-500/25 shrink-0">
              <Users size={20} />
            </div>
            <div>
              <h3 className="text-base font-black tracking-tight">Client Portfolio Executive Overview</h3>
              <p className="text-xs text-slate-400 font-medium mt-0.5">Real-time AI projections and findings across all onboarded clients</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3.5 py-2 rounded-xl bg-white/10 border border-white/10 text-center">
              <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">Active Clients</span>
              <span className="text-sm font-black text-white">{clients.length}</span>
            </div>
            <div className="px-3.5 py-2 rounded-xl bg-rose-500/20 border border-rose-500/30 text-center">
              <span className="block text-[9px] font-black uppercase tracking-widest text-rose-300">High Priority Gaps</span>
              <span className="text-sm font-black text-rose-400">{totalHighPriority}</span>
            </div>
            <div className="px-3.5 py-2 rounded-xl bg-white/10 border border-white/10 text-center">
              <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">Total Open Findings</span>
              <span className="text-sm font-black text-white">{totalOpen}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Client Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {clients.map((c) => {
          const highCount = c.healthScoreProjection?.highPriorityCount || 0;
          const openCount = c.healthScoreProjection?.openCount || 0;
          const currentHealth = c.healthScoreProjection?.points?.[0]?.value ?? 0;
          const targetHealth = c.healthScoreProjection?.points?.[c.healthScoreProjection?.points?.length - 1]?.value ?? 100;
          
          return (
            <div key={c.id} className="card p-6 space-y-4 bg-white/95 border border-slate-200/80 shadow-sm hover:shadow-md transition-all duration-300 card-hover">
              {/* Card Header */}
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white font-black grid place-items-center text-sm shadow-md shadow-indigo-500/20 shrink-0">
                    {c.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="text-base font-black text-slate-900 tracking-tight truncate">{c.name}</h3>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Active Baseline</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {highCount > 0 && (
                    <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full bg-rose-50 border border-rose-200/60 text-rose-600 shadow-2xs">
                      {highCount} High
                    </span>
                  )}
                  <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200/50">
                    {openCount} Open
                  </span>
                </div>
              </div>

              {/* Health Progress Indicator */}
              <div className="p-3 rounded-xl bg-slate-50/80 border border-slate-200/60 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-slate-700 uppercase tracking-wider">Site Health Baseline</span>
                  <span className={`text-xs font-black ${currentHealth >= 80 ? 'text-emerald-600' : currentHealth >= 50 ? 'text-amber-600' : 'text-rose-600'}`}>
                    {currentHealth}/100 ➔ {targetHealth}/100
                  </span>
                </div>
                <div className="w-32 bg-slate-200/80 rounded-full h-2 overflow-hidden shrink-0">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${currentHealth >= 80 ? 'bg-emerald-500' : currentHealth >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                    style={{ width: `${Math.max(5, currentHealth)}%` }}
                  />
                </div>
              </div>

              {/* 3 Metric Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <GrowthProjectionCard title="Health Score" icon="💚" color="#10b981" compact projection={c.healthScoreProjection} />
                <GrowthProjectionCard title="Weekly Clicks" icon="📈" color="#6C63FF" unit="/week" compact projection={c.clicksProjection} />
                <GrowthProjectionCard title="Weekly Impressions" icon="👁️" color="#f59e0b" unit="/week" compact projection={c.impressionsProjection} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Client-facing "how much have we actually grown you" view — real data
// only, strictly anchored to the site's real onboarding baseline (see
// server/agents/lib/growth-report.js). No baseline yet -> an honest empty
// state, never a chart anchored to a fabricated start date.
export default function GrowthReport({ isInternal }) {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(false);
  const [view, setView] = useState('mine'); // 'mine' | 'all'

  const load = () => api.growthReport().then(setData).catch(() => setError(true));
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

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8 fade-up">
      <PageHeader title="Milestones" icon="🌱"
        subtitle="Real progress since your onboarding baseline — every number here traces to a real, already-verified source."
        right={isInternal && (
          <div className="flex bg-slate-100/80 p-1 rounded-2xl border border-slate-200/50 shrink-0 shadow-2xs">
            <button type="button" onClick={() => setView('mine')}
              className={`text-[11px] font-extrabold px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 ${
                view === 'mine' ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/40' : 'text-slate-500 hover:text-slate-800'
              }`}>
              <User size={13} /> My Site
            </button>
            <button type="button" onClick={() => setView('all')}
              className={`text-[11px] font-extrabold px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 ${
                view === 'all' ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/40' : 'text-slate-500 hover:text-slate-800'
              }`}>
              <Users size={13} /> All Clients
            </button>
          </div>
        )} />

      {view === 'all' ? (
        <AllClientsMilestones />
      ) : error ? (
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

          {/* Section 2: Your Growth Plan */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#6C63FF]" />
              <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Your Growth Plan & AI Projections</h2>
            </div>
            <div className="space-y-4">
              <GrowthPlanNarrativeCard growthPlan={data.growthPlan} loading={false} />
              <div className="grid lg:grid-cols-3 gap-4">
                <GrowthProjectionCard title="Website Health Score" icon="💚" color="#10b981"
                  projection={data.healthScore.projection} />
                <GrowthProjectionCard title="Weekly Clicks" icon="📈" color="#6C63FF" unit="/week"
                  projection={data.performance.clicksProjection} />
                <GrowthProjectionCard title="Weekly Impressions" icon="👁️" color="#f59e0b" unit="/week"
                  projection={data.performance.impressionsProjection} />
              </div>
              <div className="grid lg:grid-cols-3 gap-4">
                <GrowthProjectionCard title="Competitor Readiness" icon="🏁" color="#f59e0b"
                  projection={data.competitorTrend?.projection} />
                <GrowthProjectionCard title="Authority Score" icon="🔗" color="#8b5cf6"
                  projection={data.authorityTrend?.projection} />
                <GrowthProjectionCard title="AI Recommendation Rate" icon="✦" color="#6C63FF" unit="%"
                  projection={data.aiRecommendationTrend?.projection} />
              </div>
            </div>
          </div>

          {/* Section 3: Performance & Health Trends */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Performance & Historical Trends</h2>
            </div>
            <div className="space-y-4">
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


