import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import GrowthTrendCard from '../components/GrowthTrendCard.jsx';

// Client-facing "how much have we actually grown you" view — real data
// only, strictly anchored to the site's real onboarding baseline (see
// server/agents/lib/growth-report.js). No baseline yet -> an honest empty
// state, never a chart anchored to a fabricated start date.
export default function GrowthReport() {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(false);

  useEffect(() => {
    api.growthReport().then(setData).catch(() => setError(true));
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader title="Milestones" icon="🌱"
        subtitle="Real progress since your onboarding baseline — every number here traces to a real, already-verified source." />

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
          <p className="text-xs text-slate-400">Measuring from your real onboarding baseline, {data.onboardedAt}, through today.</p>

          <div className="grid lg:grid-cols-2 gap-4">
            <PerformanceTrendCard series={data.performance.series} loading={false} />
            <GrowthTrendCard id="health" title="Website Health Score" icon="💚" color="#10b981"
              data={data.healthScore} emptyMessage="Not enough health-score history yet." />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <GrowthTrendCard id="competitor" title="Competitor Readiness"
              subtitle={data.competitorTrend?.domain ? `vs. ${data.competitorTrend.domain}` : undefined}
              icon="🏁" color="#f59e0b" data={data.competitorTrend}
              emptyMessage="No tracked competitor has enough history yet." />
            <GrowthTrendCard id="authority" title="Authority Score" icon="🔗" color="#8b5cf6"
              data={data.authorityTrend} emptyMessage="Needs real DataForSEO backlink data — not connected yet." />
            <GrowthTrendCard id="ai-rec" title="AI Recommendation Rate" unit="%" icon="✦" color="#6C63FF"
              data={data.aiRecommendationTrend} emptyMessage="No AI recommendation checks have run yet." />
          </div>
        </>
      )}
    </div>
  );
}
